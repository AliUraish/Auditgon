from copy import deepcopy
from pathlib import Path
from typing import Any
import asyncio
import base64
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from backend.app.auth import Context
from backend.app.config import Settings
from backend.app.errors import ApiFailure
from backend.app.gemini import GeminiClient, interaction_text, parse_provider_json
from backend.app.main import create_app
from backend.app.managed import AGENT_TOOLS, ManagedRunner, provider_state
from backend.app.models import AgentResult, AgentToolResult, Blueprint, DiscoveredItem, FindingPatch, ManualFinding, safe_asset_url
from backend.app.report import floorplan_svg, report_data, report_html
from backend.app.state import SAMPLE, add_inspection_item, add_manual_finding, advance_demo, elapsed_seconds, event, finalize, import_blueprint, initial_state, sample_state, patch_finding, start_demo, stop_clock, verdict
from backend.app.store import Store
from backend.app.uploads import save_bytes, validate_magic, validate_upload

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==")


def independent_blueprint():
    model = deepcopy(SAMPLE["blueprint"])
    model.update(isSample=False, id="real-plan", name="Independent blueprint")
    return model


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "frontend-dist", gemini_key="", api_token="")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings), base_url="http://127.0.0.1", client=("127.0.0.1", 40000)) as value:
        yield value


def test_sample_coherence_and_no_source_claims():
    snapshot = sample_state(0)["snapshot"]
    assert len(snapshot["blueprint"]["rooms"]) == 6
    assert len(snapshot["checklist"]) == 28
    assert len(snapshot["findings"]) == 5
    assert snapshot["elapsedSeconds"] == 0 and snapshot["startedAt"] is None
    assert snapshot["scan"]["assetUrl"] is None and not snapshot["scan"]["calibrated"]
    assert all(finding["isSample"] for finding in snapshot["findings"])
    for finding in snapshot["findings"]:
        assert any(item["id"] == finding["itemId"] and item.get("findingId") == finding["id"] for item in snapshot["checklist"])


def test_real_active_clock_pause_resume_and_natural_demo_finish():
    state = sample_state(1000)
    start_demo(state, 2000)
    assert elapsed_seconds(state, 7500) == 5
    stop_clock(state, 7500)
    state["snapshot"]["status"] = "paused"
    assert elapsed_seconds(state, 95000) == 5
    start_demo(state, 100000)
    assert elapsed_seconds(state, 104500) == 10
    for index in range(100):
        if state["snapshot"]["status"] != "running":
            break
        advance_demo(state, 104500 + index * 2000)
    assert index < 99
    assert state["snapshot"]["status"] == "incomplete"
    assert state["snapshot"]["verdict"] == "Incomplete"
    assert sum(item["status"] == "blocked" for item in state["snapshot"]["checklist"]) == 2


def test_verdict_requires_resolved_scope_and_matches_severity():
    state = sample_state(0)
    assert verdict(state["snapshot"]) == "Incomplete"
    for item in state["snapshot"]["checklist"]:
        item["status"] = "pass"
    assert verdict(state["snapshot"]) == "Fail"
    for finding in state["snapshot"]["findings"]:
        if finding["severity"] == "major":
            finding["status"] = "resolved"
    assert verdict(state["snapshot"]) == "Pass with notes"
    for finding in state["snapshot"]["findings"]:
        finding["status"] = "resolved"
    assert verdict(state["snapshot"]) == "Pass"
    state["snapshot"]["checklist"][0]["status"] = "blocked"
    finalize(state, 1000)
    assert state["snapshot"]["verdict"] == "Incomplete"


def test_import_clears_sample_claims_adds_visual_scope_and_invalidates_scale():
    state = sample_state(0)
    state["snapshot"]["scan"]["calibrated"] = True
    model = Blueprint.model_validate(independent_blueprint())
    import_blueprint(state, model, 5000)
    snapshot = state["snapshot"]
    assert not snapshot["findings"] and not snapshot["path"]
    assert snapshot["mode"] == "managed" and snapshot["status"] == "ready"
    assert not snapshot["scan"]["calibrated"] and state["elapsedMs"] == 0
    assert all(item["status"] == "pending" for item in snapshot["checklist"])
    assert sum(item["category"] == "Workmanship" for item in snapshot["checklist"]) == len(model.rooms)
    assert sum(item["category"] == "Visibility" for item in snapshot["checklist"]) == len(model.rooms)
    with pytest.raises(ApiFailure, match="demo runs only"):
        start_demo(state)


def test_status_edits_preserve_evidence_and_do_not_verify_blocked_items():
    state = sample_state(0)
    finding = state["snapshot"]["findings"][0]
    item = next(item for item in state["snapshot"]["checklist"] if item["id"] == finding["itemId"])
    item["status"] = "blocked"
    evidence = deepcopy(finding["evidence"])
    patch_finding(state, finding["id"], FindingPatch(status="resolved", note="Builder says fixed; reinspection pending"), 2000)
    assert item["status"] == "blocked" and finding["evidence"] == evidence and len(finding["history"]) == 2
    assert state["snapshot"]["verdict"] == "Incomplete"


def test_discovery_is_deduplicated_and_scope_and_history_are_bounded():
    state = sample_state(0)
    data = DiscoveredItem(roomId="living", label="Review new trim", category="Workmanship", reason="Visible finish candidate needs a closer image")
    first = add_inspection_item(state, data)
    second = add_inspection_item(state, data)
    assert first["itemId"] == second["itemId"] and second["existing"]
    for index in range(25):
        add_inspection_item(state, data.model_copy(update={"label": "Review new trim " + str(index)}))
    assert sum(item["id"].startswith("discovered-") for item in state["snapshot"]["checklist"]) == 20
    for index in range(500):
        event(state, "system", str(index), "bounded")
    assert len(state["snapshot"]["events"]) == 160


def test_blueprint_validation_rejects_duplicate_dangling_and_nonfinite():
    blueprint = independent_blueprint()
    blueprint["rooms"][1]["id"] = blueprint["rooms"][0]["id"]
    with pytest.raises(ValidationError, match="unique"):
        Blueprint.model_validate(blueprint)
    blueprint = independent_blueprint()
    blueprint["features"][0]["roomId"] = "missing"
    with pytest.raises(ValidationError, match="existing room"):
        Blueprint.model_validate(blueprint)
    blueprint = independent_blueprint()
    blueprint["rooms"][0]["center"][0] = float("inf")
    with pytest.raises(ValidationError):
        Blueprint.model_validate(blueprint)


def test_geometry_and_image_payload_caps():
    geometry = {"points": [{"pixel": [0.5, 0.5], "position": [1, 2, 3]}] * 64, "calibrated": False, "scale": 1, "units": "scene", "source": "rendered-depth", "note": "Approximate scene geometry, not surveyed truth"}
    assert len(AgentToolResult.model_validate({"geometry": geometry}).geometry.points) == 64
    with pytest.raises(ValidationError):
        AgentToolResult.model_validate({"geometry": {**geometry, "points": geometry["points"] + geometry["points"][:1]}})
    with pytest.raises(ValidationError):
        AgentToolResult.model_validate({"geometry": {**geometry, "units": "meters"}})
    with pytest.raises(ValidationError):
        AgentToolResult.model_validate({"geometry": {**geometry, "points": [{"pixel": [1.1, 0], "position": None}]}})
    with pytest.raises(ValidationError):
        AgentToolResult.model_validate({"imageData": "A" * 2_000_001})
    with pytest.raises(ValidationError):
        AgentToolResult.model_validate({"mimeType": "image/svg+xml"})


def test_upload_policy_magic_and_limits():
    validate_upload("blueprint", "application/pdf", 10 * 1024 * 1024)
    with pytest.raises(ApiFailure):
        validate_upload("blueprint", "application/pdf", 10 * 1024 * 1024 + 1)
    with pytest.raises(ApiFailure):
        validate_upload("reference", "image/png", 32 * 1024 * 1024 + 1)
    with pytest.raises(ApiFailure):
        validate_upload("reference", "image/svg+xml", 100)
    validate_magic("image/png", PNG)
    with pytest.raises(ApiFailure):
        validate_magic("image/jpeg", PNG)


def test_sqlite_owner_isolation_revision_cas_and_restart(settings):
    store = Store(settings)
    owner_a = store.load("owner-a")
    stale = deepcopy(owner_a)
    owner_a["snapshot"]["name"] = "A private inspection"
    store.save("owner-a", owner_a)
    with pytest.raises(ApiFailure, match="another request"):
        store.save("owner-a", stale)
    restarted = Store(settings)
    assert restarted.load("owner-a")["snapshot"]["name"] == "A private inspection"
    assert restarted.load("owner-b")["snapshot"]["id"] != owner_a["snapshot"]["id"]


def test_api_bootstrap_actions_and_reports_are_same_record(client):
    assert client.post("/api/inspection", json={"action": "reset", "mode": "demo"}).status_code == 200
    snapshot = client.get("/api/inspection").json()
    assert snapshot["blueprint"]["isSample"] and snapshot["capabilities"]["persistence"]
    started = client.post("/api/inspection", json={"action": "start", "mode": "demo"}).json()
    assert started["status"] == "running"
    paused = client.post("/api/inspection", json={"action": "pause"}).json()
    assert paused["status"] == "paused"
    assert client.post("/api/inspection", json={"action": "resume"}).json()["status"] == "running"
    final = client.post("/api/inspection", json={"action": "finalize"}).json()
    assert final["verdict"] == "Incomplete"
    report = client.get("/api/report?format=json").json()
    assert report["inspectionRevision"] == final["revision"]
    assert {item["id"] for item in report["findings"]} == {item["id"] for item in final["findings"]}
    assert "No surveyed as-built geometry available" in client.get("/api/report?format=svg").text
    assert "Show in 3D" in client.get("/api/report?format=html").text
    assert not report["holdback"]["available"]


def test_api_import_reset_no_key_and_structured_json_upload(client):
    assert client.post("/api/inspection", json={"action": "start", "mode": "managed"}).status_code == 503
    uploaded = client.post("/api/uploads", data={"kind": "blueprint"}, files={"file": ("plan.json", json.dumps(independent_blueprint()).encode(), "application/json")})
    assert uploaded.status_code == 201
    imported = client.post("/api/blueprint", json={"uploadId": uploaded.json()["id"]})
    assert imported.status_code == 200
    assert imported.json()["findings"] == [] and not imported.json()["blueprint"]["isSample"]
    assert client.post("/api/inspection", json={"action": "start", "mode": "demo"}).status_code == 409
    reset = client.post("/api/inspection", json={"action": "reset"}).json()
    assert not reset["blueprint"]["isSample"] and reset["findings"] == []
    assert reset["uploads"] == []
    assert client.get("/api/uploads/" + uploaded.json()["id"]).status_code == 200


def test_manual_source_marker_evidence_and_review_history(client):
    uploaded = client.post("/api/uploads", data={"kind": "reference"}, files={"file": ("wall.png", PNG, "image/png")})
    assert uploaded.status_code == 201
    evidence_id = uploaded.json()["id"]
    assert client.get("/api/uploads/" + evidence_id).content == PNG
    created = client.post("/api/findings", json={"roomId": "unassigned", "title": "Review wall finish", "reason": "Visible patch needs confirmation", "observed": "Uneven finish candidate", "anchor": [1, 2, 3], "annotationSource": "scan", "evidenceIds": [evidence_id]})
    assert created.status_code == 201
    finding = created.json()["findings"][-1]
    assert not finding["isSample"] and finding["annotationSource"] == "scan"
    assert finding["status"] == "review" and finding["evidence"][0]["id"] == evidence_id
    edited = client.patch("/api/findings/" + finding["id"], json={"status": "resolved", "note": "Builder repaired; recheck pending"})
    assert edited.status_code == 200
    updated = next(item for item in edited.json()["findings"] if item["id"] == finding["id"])
    assert len(updated["history"]) == 2 and updated["evidence"] == finding["evidence"]


def test_deployed_auth_requires_token_and_untrusted_headers_cannot_select_owner(settings):
    settings.api_token = "private-deployment-token"
    with TestClient(create_app(settings), base_url="https://argon.example", client=("203.0.113.5", 4000)) as client:
        assert client.get("/api/inspection").status_code == 401
        assert client.get("/api/inspection", headers={"oai-authenticated-user-id": "victim", "x-forwarded-for": "127.0.0.1"}).status_code == 401
        assert client.get("/api/inspection", headers={"Authorization": "Bearer private-deployment-token"}).status_code == 200
    settings.api_token = ""
    with TestClient(create_app(settings), base_url="https://argon.example", client=("203.0.113.5", 4000)) as client:
        assert client.get("/api/inspection").status_code == 401


def test_uploads_cannot_be_read_by_another_owner(settings):
    store = Store(settings)
    context = Context("owner-a", store, settings)
    record = save_bytes(context, "reference", "../photo.png", "image/png", PNG)
    assert "/" not in record["filename"]
    with pytest.raises(ApiFailure, match="not found"):
        store.find_upload("owner-b", record["id"])


def test_json_limits_invalid_requests_and_scene_reference_never_fetch(client, monkeypatch):
    assert client.post("/api/inspection", content=b"x" * 3000, headers={"content-type": "application/json"}).status_code == 413
    assert client.post("/api/inspection", content="broken").status_code == 400
    assert client.patch("/api/scene", json={"assetUrl": "javascript:alert(1)"}).status_code == 400
    assert client.patch("/api/scene", json={"assetUrl": "https://user:secret@example.com/file"}).status_code == 400
    requests = []
    async def forbidden(*args, **kwargs):
        requests.append(args)
        raise AssertionError("Source scan binary must never be downloaded")
    monkeypatch.setattr(httpx.AsyncClient, "request", forbidden)
    async def verified_host(_host):
        return None
    monkeypatch.setattr("backend.app.scenes.verify_public_host", verified_host)
    result = client.patch("/api/scene", json={"sourceUrl": "https://example.com/lod-meta.json"})
    assert result.status_code == 200 and requests == []


def test_report_escapes_owner_content_and_keeps_native_points_out_of_reference_map():
    snapshot = sample_state(0)["snapshot"]
    snapshot["findings"][0]["title"] = '<script>alert("x")</script>'
    html = report_html(snapshot, "https://argon.example")
    assert "&lt;script&gt;" in html and '<script>alert("x")' not in html
    assert "finding=F-001" in html
    snapshot["findings"][0]["annotationSource"] = "scan"
    assert "F-001:" not in floorplan_svg(snapshot)


def test_missing_provider_key_and_error_redaction():
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(403, text="private-key-and-stacktrace"))) as http:
            with pytest.raises(ApiFailure, match="GEMINI_API_KEY"):
                await GeminiClient("", http).request()
            with pytest.raises(ApiFailure) as raised:
                await GeminiClient("private-key-and-stacktrace", http).request()
            assert "private-key-and-stacktrace" not in raised.value.message
    asyncio.run(scenario())


def test_provider_explicit_argon_model_and_saved_tool_resume(settings):
    settings.gemini_key = "private-key"
    store = Store(settings)
    context = Context("test-owner", store, settings)
    state = store.load(context.owner)
    import_blueprint(state, Blueprint.model_validate(independent_blueprint()))
    store.save(context.owner, state)
    requests = []

    def handler(request):
        assert request.url.host == "generativelanguage.googleapis.com"
        assert "private-key" not in str(request.url)
        assert request.headers["x-goog-api-key"] == "private-key"
        body = json.loads(request.content)
        requests.append(body)
        assert body["model"] == "gemini-4-argon"
        if len(requests) == 1:
            return httpx.Response(200, json={"id": "turn-1", "status": "requires_action", "environment_id": "env-1", "steps": [{"id": "capture-1", "type": "function_call", "name": "inspect_view", "arguments": {"label": "First real view"}}]})
        assert body["previous_interaction_id"] == "turn-1"
        assert body["input"][0]["type"] == "function_result" and body["input"][0]["call_id"] == "capture-1"
        return httpx.Response(200, json={"id": "turn-2", "status": "completed", "output_text": "Metric evidence remains unavailable; request calibration."})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            runner = ManagedRunner(context, GeminiClient(settings.gemini_key, http))
            await runner.start(state)
            assert store.load(context.owner)["snapshot"]["agent"]["pendingTool"]["id"] == "capture-1"
            result = await runner.submit_viewer_result("capture-1", AgentToolResult(imageData=base64.b64encode(PNG).decode(), mimeType="image/png"))
            assert result["snapshot"]["status"] == "incomplete"
            assert "imageData" not in json.dumps(store.load(context.owner))
            assert result["snapshot"]["uploads"][0]["kind"] == "reference"
    asyncio.run(scenario())
    assert len(requests) == 2


def test_agent_metric_claims_stay_blocked_but_visual_candidates_have_real_evidence(settings):
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    import_blueprint(state, Blueprint.model_validate(independent_blueprint()))
    file = save_bytes(context, "reference", "capture.png", "image/png", PNG)
    async def scenario():
        async with httpx.AsyncClient() as http:
            runner = ManagedRunner(context, GeminiClient("", http))
            metric = state["snapshot"]["checklist"][0]
            saved = runner.commit_result(state, {"itemId": metric["id"], "status": "pass", "observed": "4.2 m", "reason": "Model guessed from blueprint", "evidenceIds": [file["id"]]})
            assert saved["status"] == "blocked"
            visual = next(item for item in state["snapshot"]["checklist"] if item["category"] == "Workmanship")
            result = runner.commit_result(state, {"itemId": visual["id"], "status": "finding", "basis": "visual", "observed": "Possible absent cover", "reason": "Close capture needs confirmation", "evidenceIds": [file["id"]], "finding": {"title": "Review outlet cover", "severity": "minor", "expected": "Cover installed", "nextAction": "Confirm with original photo"}})
            assert result["status"] == "finding"
            assert state["snapshot"]["findings"][-1]["status"] == "review"
            assert state["snapshot"]["findings"][-1]["annotationSource"] == "reference"
            provider_state(state)["geometrySamples"] = [[1, 2, 3]]
            anchored = runner.commit_result(state, {"itemId": visual["id"], "status": "finding", "basis": "visual", "observed": "Possible absent cover", "reason": "Candidate is at a returned depth sample", "evidenceIds": [file["id"]], "finding": {"title": "Review outlet cover", "severity": "minor", "expected": "Cover installed", "nextAction": "Confirm original capture", "anchor": [1, 2, 3]}})
            assert anchored["findingId"] == result["findingId"]
            assert state["snapshot"]["findings"][-1]["annotationSource"] == "scan"
            assert state["snapshot"]["findings"][-1]["anchor"] == [1, 2, 3]
    asyncio.run(scenario())


def test_failed_provider_continuation_resumes_without_replaying_a_tool_commit(settings):
    settings.gemini_key = "key"
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    import_blueprint(state, Blueprint.model_validate(independent_blueprint()))
    store.save(context.owner, state)
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return httpx.Response(200, json={"id": "turn-1", "status": "requires_action", "environment_id": "env-1", "steps": [{"id": "read-1", "type": "function_call", "name": "read_blueprint", "arguments": {}}]})
        if len(calls) == 2:
            return httpx.Response(503, text="private provider trace")
        assert body["previous_interaction_id"] == "turn-1"
        assert body["input"][0]["call_id"] == "read-1"
        return httpx.Response(200, json={"id": "turn-2", "status": "in_progress"})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            runner = ManagedRunner(context, GeminiClient("key", http))
            with pytest.raises(ApiFailure):
                await runner.start(state)
            saved = store.load(context.owner)
            assert saved["snapshot"]["status"] == "error"
            assert saved["provider"]["continuation"]["results"][0]["callId"] == "read-1"
            await runner.start(saved)
            assert saved["provider"]["executedCalls"] == ["read-1"]
            assert "continuation" not in saved["provider"]
            assert saved["snapshot"]["status"] == "running"
    asyncio.run(scenario())
    assert len(calls) == 3


def test_static_production_frontend_is_served_from_same_origin(settings):
    settings.frontend_dist.mkdir()
    (settings.frontend_dist / "index.html").write_text("<html>Argon React frontend</html>")
    (settings.frontend_dist / "asset.js").write_text("console.log('asset')")
    with TestClient(create_app(settings), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        assert "Argon React frontend" in client.get("/").text
        assert "console.log" in client.get("/asset.js").text
        assert client.get("/api/missing").status_code == 404
        assert client.get("/api/health").json()["runtime"] == "Python FastAPI"
