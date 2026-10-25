"""FastAPI entry point; serves the built React frontend from one origin."""
from contextlib import asynccontextmanager
from typing import Any, Optional
from pathlib import Path
import json
import asyncio
import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from .auth import Context, context_for, public_snapshot
from .blueprint import extract_blueprint
from .config import RESOURCE_LIMITS, Settings
from .errors import ApiFailure, error_json, register_errors
from .gemini import GeminiClient
from .managed import ManagedRunner
from .models import Action, AgentToolResult, Blueprint, BlueprintRequest, FindingPatch, ManualFinding, ScenePatch, ProjectReset, safe_asset_url
from .report import floorplan_svg, report_data, report_html, blueprint_3d_json, blueprint_obj, run_diff
from .state import add_manual_finding, advance_demo, attach_design_reference, event, finalize, import_blueprint, initial_state, sample_state, patch_finding, start_demo, start_reaudit, stop_clock, replace_scene
from .scenes import resolve_scene, scene_id, supported_scene_filename
from .store import Store
from .uploads import evidence_for, save_upload_file


class RequestLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        limit = 33 * 1024 * 1024 if path == "/api/uploads" else 2_100_000 if path.startswith("/api/agent-tools/") else 512 * 1024
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await error_json(400, "Invalid content length.", "INVALID_INPUT")(scope, receive, send)
        if length > limit:
            return await error_json(413, "The request exceeds its bounded input limit.", "INPUT_TOO_LARGE")(scope, receive, send)
        size = 0

        async def bounded_receive():
            nonlocal size
            message = await receive()
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > limit:
                    raise ApiFailure(413, "The request exceeds its bounded input limit.", "INPUT_TOO_LARGE")
            return message

        async def no_store_send(message):
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers.extend([(b"cache-control", b"private, no-store"), (b"x-content-type-options", b"nosniff")])
                message["headers"] = response_headers
            await send(message)

        await self.app(scope, bounded_receive, no_store_send)


async def read_json(request: Request, model, limit: int = 512 * 1024):
    contents = bytearray()
    async for chunk in request.stream():
        if len(contents) + len(chunk) > limit:
            raise ApiFailure(413, "This JSON input is too large.", "INPUT_TOO_LARGE")
        contents.extend(chunk)
    try:
        value = json.loads(contents, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("Nonfinite number")))
    except (ValueError, UnicodeDecodeError):
        raise ApiFailure(400, "A valid JSON request body is required.", "INVALID_JSON") from None
    return model.model_validate(value)


def create_app(settings: Optional[Settings] = None, transport: Optional[httpx.AsyncBaseTransport] = None) -> FastAPI:
    configuration = settings or Settings()
    store = Store(configuration)
    http_client = httpx.AsyncClient(transport=transport, limits=httpx.Limits(max_connections=4, max_keepalive_connections=2), follow_redirects=False)

    @asynccontextmanager
    async def lifespan(_app):
        _app.state.heavy_operations = asyncio.Semaphore(2)
        yield
        await http_client.aclose()

    application = FastAPI(title="Auditgon inspection API", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    application.state.settings = configuration
    application.state.store = store
    application.state.provider = GeminiClient(configuration.gemini_key, http_client)
    application.state.http = http_client
    application.state.heavy_operations = None
    application.add_middleware(RequestLimitMiddleware)
    register_errors(application)

    def runner(context: Context):
        return ManagedRunner(context, application.state.provider)

    @application.get("/api/health")
    async def health():
        return {"ok": True, "service": "Auditgon inspection", "runtime": "Python FastAPI", "authentication": "Configured bearer token, or loopback-only local owner", "capabilities": {
            "persistence": True, "uploads": True, "managedAgent": bool(configuration.gemini_key), "managedAgentModel": "gemini-4-argon", "managedAgentHarness": "antigravity-preview-09-2026", "blueprintExtraction": bool(configuration.gemini_key), "embeddedScan": True, "clientCameraAndCaptureRequired": True, "validatedMetricGeometry": False, "asBuilt": "generated-model-draft", "holdback": "requires-contract-and-quotes"}, "limits": {**RESOURCE_LIMITS, "maxAgentTurns": configuration.max_agent_turns}}

    @application.post("/api/project")
    async def new_project(request: Request, context: Context = Depends(context_for)):
        if request.headers.get("content-length") != "0":
            raw = await request.body()
            if len(raw) > 2048:
                raise ApiFailure(413, "Project reset input is too large.", "INPUT_TOO_LARGE")
            if raw:
                try:
                    ProjectReset.model_validate(json.loads(raw))
                except ValueError:
                    raise ApiFailure(400, "Use an empty project reset body or {action:'reset'}.", "INVALID_INPUT") from None
        previous = store.load(context.owner)
        if previous["snapshot"]["mode"] == "managed":
            await runner(context).cancel(previous)
        state = initial_state()
        state["snapshot"]["revision"] = previous["snapshot"]["revision"]
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.get("/api/inspection")
    async def get_inspection(context: Context = Depends(context_for)):
        return public_snapshot(context, store.load(context.owner))

    @application.post("/api/inspection")
    async def inspection_action(request: Request, context: Context = Depends(context_for)):
        data = await read_json(request, Action, 2048)
        state = store.load(context.owner)
        managed = runner(context)
        if data.action in ("start", "resume"):
            if (data.mode or state["snapshot"]["mode"]) == "managed":
                async with application.state.heavy_operations:
                    await managed.start(state)
            else:
                start_demo(state)
        elif data.action == "advance":
            if state["snapshot"]["mode"] == "managed":
                async with application.state.heavy_operations:
                    changed = await managed.advance(state)
                if not changed:
                    return public_snapshot(context, store.load(context.owner))
            else:
                advance_demo(state)
        elif data.action == "pause" and state["snapshot"]["status"] == "running":
            if state["snapshot"]["mode"] == "managed":
                await managed.cancel(state)
            stop_clock(state)
            state["snapshot"]["status"] = "paused"
            event(state, "system", "Inspection paused", "Active elapsed time stopped. Saved scope, findings, and evidence remain available.")
        elif data.action == "finalize":
            if state["snapshot"]["mode"] == "managed":
                await managed.cancel(state)
            finalize(state)
        elif data.action == "reaudit":
            if state["snapshot"]["mode"] == "managed":
                await managed.cancel(state)
            start_reaudit(state)
            async with application.state.heavy_operations:
                await managed.start(state)
                await managed.auto_deploy_team(state, "re-audit start, from the previous run's captures")
        elif data.action == "reset":
            if state["snapshot"]["mode"] == "managed":
                await managed.cancel(state)
            previous = state
            state = sample_state() if data.mode == "demo" else initial_state()
            state["snapshot"]["revision"] = previous["snapshot"]["revision"]
            if data.mode == "demo":
                state["snapshot"]["uploads"] = previous["snapshot"]["uploads"]
                event(state, "system", "Explicit sample workspace reset", "Synthetic data loaded only by the explicit demo API request.")
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.post("/api/findings", status_code=201)
    async def manual_finding(request: Request, context: Context = Depends(context_for)):
        data = await read_json(request, ManualFinding, 20_000)
        evidence = evidence_for(context, data.evidenceIds)
        state = store.load(context.owner)
        add_manual_finding(state, data)
        state["snapshot"]["findings"][-1]["evidence"] = evidence
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.patch("/api/findings/{finding_id}")
    async def update_finding(finding_id: str, request: Request, context: Context = Depends(context_for)):
        data = await read_json(request, FindingPatch, 5000)
        state = store.load(context.owner)
        patch_finding(state, finding_id, data)
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.post("/api/uploads", status_code=201)
    async def upload(request: Request, context: Context = Depends(context_for)):
        if not request.headers.get("content-type", "").startswith("multipart/form-data"):
            raise ApiFailure(415, "Use a multipart file upload.", "INVALID_MULTIPART")
        async with application.state.heavy_operations:
            async with request.form(max_files=1, max_fields=2) as form:
                file, kind = form.get("file"), form.get("kind")
                if not isinstance(file, UploadFile) or not isinstance(kind, str):
                    raise ApiFailure(400, "A file and kind are required.", "FILE_REQUIRED")
                return await save_upload_file(context, kind, file)

    @application.get("/api/uploads/{upload_id}")
    async def download(upload_id: str, context: Context = Depends(context_for)):
        record = store.find_upload(context.owner, upload_id)
        path = store.object_path(record)
        if not path.is_file():
            raise ApiFailure(404, "The uploaded file is no longer available.", "NOT_FOUND")
        inline = record["content_type"].startswith("image/") or record["content_type"] == "application/pdf"
        return FileResponse(path, media_type=record["content_type"], filename=record["filename"], content_disposition_type="inline" if inline else "attachment", headers={"Content-Security-Policy": "default-src 'none'; sandbox"})

    @application.post("/api/blueprint")
    async def blueprint(request: Request, context: Context = Depends(context_for)):
        data = await read_json(request, BlueprintRequest)
        state = store.load(context.owner)
        async with application.state.heavy_operations:
            model = await extract_blueprint(context, application.state.provider, data.uploadId) if data.uploadId else Blueprint.model_validate(data.blueprint)
        state = store.load(context.owner)  # extraction takes seconds; re-read so a running audit's progress is kept
        if state["snapshot"]["blueprint"].get("generatedFrom") == "scan" and state["snapshot"]["blueprint"]["rooms"]:
            attach_design_reference(state, model)
        else:
            if state["snapshot"]["status"] == "running":
                raise ApiFailure(409, "Pause the inspection before replacing its independent reference.", "RUN_ACTIVE")
            import_blueprint(state, model)
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.patch("/api/scene")
    async def scene(request: Request, context: Context = Depends(context_for)):
        data = await read_json(request, ScenePatch, 5000)
        state = store.load(context.owner)
        snapshot = state["snapshot"]
        if snapshot["status"] == "running":
            raise ApiFailure(409, "Pause the inspection before changing scan registration.", "RUN_ACTIVE")
        if "sourceUrl" in data.model_fields_set or "assetUrl" in data.model_fields_set:
            candidate = data.sourceUrl if "sourceUrl" in data.model_fields_set else data.assetUrl
            current_scan = snapshot["scan"]
            same_source = bool(candidate and current_scan.get("configured") and (candidate in (current_scan.get("sourceUrl"), current_scan.get("assetUrl")) or (scene_id(candidate) and scene_id(candidate) == scene_id(current_scan.get("sourceUrl", "")))))
            if same_source:
                replacement = None
            elif not candidate:
                replacement = {"sourceUrl": "", "assetUrl": None, "configured": False, "posterUrl": None, "name": "No scan selected"}
            elif candidate.startswith("/api/uploads/"):
                url = safe_asset_url(candidate)
                record = store.find_upload(context.owner, url.rsplit("/", 1)[-1])
                if record["kind"] != "scan":
                    raise ApiFailure(400, "Choose an owned scan upload.", "INVALID_SCENE_UPLOAD")
                if not supported_scene_filename(record["filename"]):
                    raise ApiFailure(415, "This viewer supports .sog, .ply, or progressive lod-meta.json scans. Export the uploaded scan in a supported format.", "UNSUPPORTED_SCENE_FORMAT")
                replacement = {"sourceUrl": url, "assetUrl": url, "configured": True, "posterUrl": None, "name": record["filename"]}
            else:
                async with application.state.heavy_operations:
                    replacement = await resolve_scene(application.state.http, candidate)
            if replacement is not None:
                replacement.update(calibrated=False, scale=1, version="scan-" + str(snapshot["revision"] + 1))
                replace_scene(state, replacement)
                snapshot = state["snapshot"]
        if data.name is not None:
            snapshot["name"] = data.name
            snapshot["scan"]["name"] = data.name
        scale_changed = data.scale is not None and data.scale != snapshot["scan"]["scale"]
        if data.scale is not None:
            snapshot["scan"]["scale"] = data.scale
        if data.calibrated is not None:
            snapshot["scan"]["calibrated"] = data.calibrated
        if scale_changed and not snapshot["blueprint"]["isSample"]:
            for item in snapshot["checklist"]:
                if item["status"] in ("pass", "finding"):
                    item.update(status="pending", reason="Scale changed; prior result requires re-verification.")
            snapshot.update(verdict="Incomplete", status="ready", corrections=snapshot["corrections"] + 1)
        event(state, "system", "Scan settings saved", "Scale changed; dependent results reopened." if scale_changed else "Remote URL saved as a reference. This server never downloads or proxies source scan binaries.")
        store.save(context.owner, state)
        return public_snapshot(context, state)

    @application.post("/api/agent-tools/{tool_id}")
    async def agent_tool(tool_id: str, request: Request, context: Context = Depends(context_for)):
        if len(tool_id) > 180:
            raise ApiFailure(400, "Tool request ID is too long.", "INVALID_INPUT")
        async with application.state.heavy_operations:
            data = await read_json(request, AgentToolResult, 2_100_000)
            state = await runner(context).submit_viewer_result(tool_id, data)
        return public_snapshot(context, state)

    @application.get("/api/report")
    async def report(request: Request, format: str = "json", finding: Optional[str] = None, context: Context = Depends(context_for)):
        state = store.load(context.owner)
        snapshot = public_snapshot(context, state)
        if format == "json":
            data = report_data(snapshot, state.get("designReference"))
            if state.get("designReference"):
                data["designReference"] = state["designReference"]
            return data
        if format == "blueprint":
            return blueprint_3d_json(snapshot)
        if format == "diff":
            runs = state.get("runs", [])
            return run_diff(snapshot, runs[-1] if runs else None)
        if format == "obj":
            return Response(blueprint_obj(snapshot), media_type="text/plain", headers={"Content-Disposition": "attachment; filename=auditgon-draft-3d.obj"})
        if format == "html":
            return HTMLResponse(report_html(snapshot, str(request.base_url).rstrip("/"), state.get("designReference")), headers={"Content-Disposition": "inline; filename=auditgon-inspection-r{}.html".format(snapshot["revision"]), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'self'"})
        if format == "svg":
            return Response(floorplan_svg(snapshot, finding), media_type="image/svg+xml", headers={"Content-Disposition": "inline; filename=auditgon-inspection-r{}.svg".format(snapshot["revision"]), "Content-Security-Policy": "default-src 'none'; sandbox"})
        raise ApiFailure(400, "Choose report format json, html, svg, blueprint, obj, or diff.", "INVALID_FORMAT")

    @application.get("/{file_path:path}")
    async def frontend(file_path: str):
        if file_path == "api" or file_path.startswith("api/"):
            raise ApiFailure(404, "API route not found.", "NOT_FOUND")
        dist = configuration.frontend_dist.resolve()
        requested = (dist / file_path).resolve()
        if requested != dist and dist not in requested.parents:
            raise ApiFailure(404, "File not found.", "NOT_FOUND")
        if requested.is_file():
            return FileResponse(requested)
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index)
        return HTMLResponse("<h1>Auditgon Python backend is running</h1><p>Build frontend/ with npm run build, or use the Vite development server.</p>")

    return application


app = create_app()
