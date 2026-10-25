"""Input-first Auditgon workflow; HTTP fixtures never fetch a source binary."""
from copy import deepcopy
from pathlib import Path
import asyncio
import base64
import json
import socket
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.app.auth import Context
from backend.app.config import Settings
from backend.app.errors import ApiFailure
from backend.app.gemini import GeminiClient
from backend.app.main import create_app
from backend.app.managed import ManagedRunner, provider_state
from backend.app.materials import read_materials
from backend.app.models import Blueprint, MaterialRead, ManualFinding, safe_asset_url
from backend.app.report import blueprint_3d_json, blueprint_obj, floorplan_svg, report_data, report_html
from backend.app.scenes import parse_bootstrap, resolve_scene, verify_public_host
from backend.app.state import SAMPLE, add_manual_finding, finalize, import_blueprint, initial_state, sample_state, now_ms, verdict
from backend.app.store import Store
from backend.app.uploads import save_bytes

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==")
SCENE_URL = "https://superspl.at/scene/9d09ab82"


def settings_for(tmp_path, key=""):
    return Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "frontend", gemini_key=key, api_token="")


def bootstrap_html(position=None, target=None, content=None):
    return '<html><script id="sse-bootstrap" type="application/json">' + json.dumps({
        "contentUrl": content or "https://d28zzqy0iyovbz.cloudfront.net/9d09ab82/v2/lod-meta.json",
        "posterUrl": "https://s3-eu-west-1.amazonaws.com/images.playcanvas.com/splat/9d09ab82/v2/xl.webp",
        "settings": {"cameras": [{"initial": {"position": position, "target": target}}]},
    }) + '</script></html>'


def draft_model(source="materials"):
    model = deepcopy(SAMPLE["blueprint"])
    model.update(id="derived-model", name="Evidence-derived test model", isSample=False, generatedFrom=source,
                 coordinateFrame="scan" if source == "scan" else "reference", metricStatus="unmeasured", units="m")
    model["features"].append({"id": "observed-sofa", "roomId": "living", "kind": "furniture", "objectType": "sofa", "label": "Observed sofa", "position": [-4, 0.5, -3], "dimensions": [2.2, 1, 1.1], "rotation": 90})
    return model


def test_fresh_project_is_empty_and_cannot_pass_zero_scope(tmp_path):
    with TestClient(create_app(settings_for(tmp_path)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        snapshot = client.get("/api/inspection").json()
        assert snapshot["blueprint"]["rooms"] == [] and snapshot["checklist"] == [] and snapshot["findings"] == []
        assert not snapshot["scan"]["configured"] and snapshot["scan"]["sourceUrl"] == ""
        final = client.post("/api/inspection", json={"action": "finalize"}).json()
        assert final["status"] == "incomplete" and final["verdict"] == "Incomplete"
        assert "Spatial model pending" in client.get("/api/report?format=svg").text
        assert client.get("/api/report?format=blueprint").json()["rooms"] == []
        assert "No spatial model generated yet" in client.get("/api/report?format=obj").text


def test_scene_resolution_only_reads_allowlisted_small_html_and_never_binary(tmp_path):
    requests = []
    def handler(request):
        requests.append(request)
        assert request.method == "GET" and request.url.host == "superspl.at" and request.url.path == "/s"
        return httpx.Response(200, text=bootstrap_html([1, 2, 3], [0, 1, 0]), headers={"content-type": "text/html"})
    app = create_app(settings_for(tmp_path), transport=httpx.MockTransport(handler))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        selected = client.patch("/api/scene", json={"sourceUrl": SCENE_URL, "name": "Lake house"})
        assert selected.status_code == 200
        scan = selected.json()["scan"]
        assert scan["configured"] and scan["assetUrl"].endswith("/lod-meta.json")
        assert scan["posterUrl"].endswith("/xl.webp") and scan["initialCameraPosition"] == [1, 2, 3]
        assert scan["initialCameraTarget"] == [0, 1, 0] and selected.json()["name"] == "Lake house"
    assert len(requests) == 1


def test_scene_replacement_invalidates_old_results_but_keeps_materials_and_same_link_is_idempotent(tmp_path):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, text=bootstrap_html(), headers={"content-type": "text/html"})
    with TestClient(create_app(settings_for(tmp_path), transport=httpx.MockTransport(handler)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        upload = client.post("/api/uploads", data={"kind": "reference"}, files={"file": ("photo.png", PNG, "image/png")}).json()
        assert client.patch("/api/scene", json={"sourceUrl": SCENE_URL}).status_code == 200
        assert client.post("/api/blueprint", json={"blueprint": draft_model()}).status_code == 200
        marker = client.post("/api/findings", json={"roomId": "living", "title": "Source observation", "reason": "Owner observation needs confirmation", "observed": "Visible patch", "anchor": [1, 2, 3], "annotationSource": "scan"}).json()["findings"][-1]
        unchanged = client.patch("/api/scene", json={"sourceUrl": "https://superspl.at/s?id=9d09ab82", "name": "Updated title"}).json()
        assert any(finding["id"] == marker["id"] for finding in unchanged["findings"])
        assert unchanged["blueprint"]["rooms"] and len(calls) == 1
        # A different local owned scan constitutes a different house and invalidates all old audit output.
        scan_upload = client.post("/api/uploads", data={"kind": "scan"}, files={"file": ("optimized.sog", b"test-scene-fixture", "application/octet-stream")}).json()
        replaced = client.patch("/api/scene", json={"assetUrl": scan_upload["url"]}).json()
        assert replaced["findings"] == [] and replaced["blueprint"]["rooms"] == [] and replaced["checklist"] == []
        assert {file["id"] for file in replaced["uploads"]} == {upload["id"], scan_upload["id"]}
        reset = client.post("/api/project", json={}).json()
        assert reset["uploads"] == [] and not reset["scan"]["configured"] and reset["blueprint"]["rooms"] == []
        assert client.get(upload["url"]).content == PNG  # Private owner file retained without reattaching it to another project.


@pytest.mark.parametrize("url", ["https://127.0.0.1/a.sog", "https://10.0.0.2/a.sog", "https://169.254.169.254/a.sog", "https://localhost/a.sog", "https://host.local/a.sog", "https://[::1]/a.sog", "http://example.com/a.sog", "https://user:secret@example.com/a.sog", "file:///tmp/a.sog", "https://example.com:8000/a.sog"])
def test_private_local_or_unsafe_scan_links_are_rejected(url):
    with pytest.raises(ApiFailure):
        safe_asset_url(url)


def test_dns_private_address_and_direct_reference_zero_http(monkeypatch):
    requests = []
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443))])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: requests.append(request))) as client:
            with pytest.raises(ApiFailure, match="private network"):
                await resolve_scene(client, "https://public-name.example.com/lod-meta.json")
            monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))])
            result = await resolve_scene(client, "https://public-name.example.com/lod-meta.json")
            assert result["assetUrl"].endswith("lod-meta.json")
    asyncio.run(scenario())
    assert requests == []


def test_metadata_redirect_limits_content_safety_and_optional_cameras():
    no_camera = parse_bootstrap(bootstrap_html(), "9d09ab82")
    assert "initialCameraPosition" not in no_camera and "initialCameraTarget" not in no_camera
    with pytest.raises(ApiFailure):
        parse_bootstrap(bootstrap_html(content="https://127.0.0.1/9d09ab82/scene.sog"), "9d09ab82")
    with pytest.raises(ApiFailure):
        parse_bootstrap(bootstrap_html(content="https://unapproved.example.com/9d09ab82/scene.sog"), "9d09ab82")
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(302, headers={"location": "https://127.0.0.1/private"}))) as client:
            with pytest.raises(ApiFailure, match="official SuperSplat"):
                await resolve_scene(client, SCENE_URL)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=b"x" * (512 * 1024 + 1), headers={"content-type": "text/html"}))) as client:
            with pytest.raises(ApiFailure, match="size limit"):
                await resolve_scene(client, SCENE_URL)
    asyncio.run(scenario())


def test_materials_read_real_owned_images_pdf_text_and_create_model_persists(tmp_path):
    settings = settings_for(tmp_path, "key")
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    photo = save_bytes(context, "reference", "room.png", "image/png", PNG)
    document = save_bytes(context, "reference", "notes.pdf", "application/pdf", b"%PDF-1.4 test-reference")
    text = save_bytes(context, "reference", "scope.md", "text/markdown", b"Living room and kitchen are connected. Check visible finishes.")
    state["snapshot"]["uploads"] = [photo, document, text]
    state["snapshot"].update(status="running", startedAt="2026-10-25T00:00:00.000Z")
    state["activeSince"] = now_ms()
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert "model" in body and body["input"][1]["type"] == "document"
        return httpx.Response(200, json={"id": "pdf-read", "status": "completed", "output_text": "The supplied PDF describes a living room connected to a kitchen. No metric dimensions are stated."})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            provider = GeminiClient("key", http)
            result, images = await read_materials(context, provider, state, MaterialRead(uploadIds=[photo["id"], document["id"], text["id"]]))
            assert images == [photo["id"]]
            assert "supplied PDF" in result["materials"][1]["text"]
            assert "Check visible finishes" in result["materials"][2]["text"]
            assert len(provider_state(state)["readMaterialIds"]) == 3
            runner = ManagedRunner(context, provider)
            created = runner.create_spatial_model(state, {"blueprint": draft_model(), "evidenceIds": [document["id"], text["id"]], "reason": "Rooms and observed furniture derived from supplied test materials"})
            assert created["saved"] and created["generatedFrom"] == "materials"
            store.save(context.owner, state)
            persisted = Store(settings).load(context.owner)
            assert persisted["snapshot"]["blueprint"]["features"][-1]["objectType"] == "sofa"
            assert persisted["snapshot"]["status"] == "running" and persisted["activeSince"] is not None
            assert not any(item["category"] == "furniture" for item in persisted["snapshot"]["checklist"])
    asyncio.run(scenario())
    assert len(calls) == 1


def test_scan_model_requires_actual_capture_and_depth_forces_scene_units_and_exports(tmp_path):
    settings = settings_for(tmp_path)
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    capture = save_bytes(context, "reference", "scan-capture-1.png", "image/png", PNG)
    state["snapshot"]["uploads"] = [capture]
    async def scenario():
        async with httpx.AsyncClient() as http:
            runner = ManagedRunner(context, GeminiClient("", http))
            input_data = {"blueprint": draft_model("scan"), "evidenceIds": [capture["id"]], "reason": "Approximate native surfaces from this real capture/depth fixture"}
            assert "error" in runner.create_spatial_model(state, input_data)
            assert state["snapshot"]["blueprint"]["rooms"] == []
            provider_state(state)["geometrySamples"] = [[-8, 0, -6], [0, 0, -6], [0, 0, 0]]
            result = runner.create_spatial_model(state, input_data)
            assert result["saved"] and result["units"] == "scene" and result["metricStatus"] == "unmeasured"
            model = state["snapshot"]["blueprint"]
            assert all(room["area"] == 0 for room in model["rooms"])
            assert all("expected" not in feature for feature in model["features"])
            exported = blueprint_3d_json(state["snapshot"])
            assert exported["rooms"] == model["rooms"] and exported["units"] == "scene"
            obj = blueprint_obj(state["snapshot"])
            assert "# Units: scene" in obj and "furniture_observed-sofa" in obj
            assert "NOT actual wall heights" in obj and "v " in obj
            svg = floorplan_svg(state["snapshot"])
            assert "scene units" in svg and "· meters" not in svg
            assert report_data(state["snapshot"])["spatialModelProvenance"]["generatedFrom"] == "scan"
    asyncio.run(scenario())


def test_managed_discovery_starts_with_only_scan_and_no_blueprint(tmp_path):
    calls = []
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, text=bootstrap_html([1, 2, 3], [0, 1, 0]), headers={"content-type": "text/html"})
        body = json.loads(request.content)
        calls.append(body)
        assert body["model"] == "gemini-4-argon"
        assert {tool.get("name") for tool in body["tools"]} >= {"read_materials", "create_spatial_model", "inspect_view"}
        return httpx.Response(200, json={"id": "discovery-1", "status": "requires_action", "environment_id": "env-1", "steps": [{"id": "view-1", "type": "function_call", "name": "inspect_view", "arguments": {"label": "Discover the first room"}}]})
    with TestClient(create_app(settings_for(tmp_path, "key"), transport=httpx.MockTransport(handler)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        assert client.patch("/api/scene", json={"sourceUrl": SCENE_URL}).status_code == 200
        started = client.post("/api/inspection", json={"action": "start", "mode": "managed"})
        assert started.status_code == 200
        assert started.json()["blueprint"]["rooms"] == [] and started.json()["status"] == "running"
        assert started.json()["agent"]["pendingTool"]["name"] == "inspect_view"
    assert len(calls) == 1


def test_legacy_bootstrap_migrates_without_erasing_owner_observations_or_real_projects(tmp_path):
    settings = settings_for(tmp_path)
    store = Store(settings)
    current = store.load("owner")
    old = sample_state()
    old.pop("projectVersion")
    old["snapshot"]["revision"] = current["snapshot"]["revision"]
    photo = save_bytes(Context("owner", store, settings), "reference", "owner.png", "image/png", PNG)
    old["snapshot"]["uploads"] = [photo]
    add_manual_finding(old, ManualFinding(roomId="living", title="Owner source point", reason="Real owner observation", observed="Review visible patch", anchor=[1, 2, 3], annotationSource="scan"))
    store.save("owner", old)
    migrated = store.load("owner")
    assert migrated["snapshot"]["blueprint"]["rooms"] == [] and len(migrated["snapshot"]["findings"]) == 1
    assert not migrated["snapshot"]["findings"][0]["isSample"] and migrated["snapshot"]["uploads"] == [photo]
    real = store.load("real-owner")
    import_blueprint(real, Blueprint.model_validate(draft_model()))
    real.pop("projectVersion")
    store.save("real-owner", real)
    assert len(store.load("real-owner")["snapshot"]["blueprint"]["rooms"]) == 6


def test_configurable_agent_budget_supports_full_house_but_stops_incomplete(tmp_path, monkeypatch):
    monkeypatch.delenv("ARGON_MAX_AGENT_TURNS", raising=False)
    assert settings_for(tmp_path).max_agent_turns == 512
    monkeypatch.setenv("ARGON_MAX_AGENT_TURNS", "10000")
    assert settings_for(tmp_path).max_agent_turns == 1024
    settings = settings_for(tmp_path, "key")
    settings.max_agent_turns = 512
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    state["snapshot"].update(status="running", agent={"interactionId": "done", "status": "completed"})
    provider_state(state)["rounds"] = 512
    async def scenario():
        async with httpx.AsyncClient() as http:
            await ManagedRunner(context, GeminiClient("key", http)).advance(state)
    asyncio.run(scenario())
    assert state["snapshot"]["status"] == "incomplete" and state["snapshot"]["verdict"] == "Incomplete"


def test_viewer_rejects_unsupported_direct_and_uploaded_scan_formats(tmp_path):
    requests = []
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: requests.append(request))) as http:
            for extension in ("spz", "splat", "ksplat"):
                with pytest.raises(ApiFailure, match=r"\.sog or \.ply"):
                    await resolve_scene(http, "https://example.com/scan." + extension)
    asyncio.run(scenario())
    assert requests == []
    with TestClient(create_app(settings_for(tmp_path)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        uploaded = client.post("/api/uploads", data={"kind": "scan"}, files={"file": ("scan.spz", b"unsupported-scan-fixture", "application/octet-stream")})
        assert uploaded.status_code == 201
        selected = client.patch("/api/scene", json={"assetUrl": uploaded.json()["url"]})
        assert selected.status_code == 415 and selected.json()["code"] == "UNSUPPORTED_SCENE_FORMAT"
        assert not client.get("/api/inspection").json()["scan"]["configured"]


def sketch_model():
    model = deepcopy(SAMPLE["blueprint"])
    model.update(id="owner-sketch", name="Owner sketch", isSample=False, generatedFrom="materials", coordinateFrame="reference", metricStatus="unmeasured", units="scene")
    for feature in model["features"]:
        feature.pop("expected", None)
        feature.pop("unit", None)
    return model


def test_sketch_import_generates_room_connection_and_feature_claims(tmp_path):
    settings = settings_for(tmp_path)
    store = Store(settings)
    state = store.load("owner")
    import_blueprint(state, Blueprint.model_validate(sketch_model()))
    checklist = state["snapshot"]["checklist"]
    rooms = [item for item in checklist if item["id"].startswith("sketch-room-")]
    links = [item for item in checklist if item["id"].startswith("sketch-link-")]
    features = [item for item in checklist if item["id"].startswith("sketch-feature-")]
    assert len(rooms) == 6 and all(item["category"] == "Layout" for item in rooms)
    assert links and len({item["id"] for item in links}) == len(links)
    assert features and all(item["category"] == "Presence" for item in features)
    assert not any(item["id"].startswith("check-") for item in checklist), "no written dimensions means no metric checks"
    assert state["designReference"]["id"] == "owner-sketch"
    assert all(item["roomId"] in {room["id"] for room in sketch_model()["rooms"]} for item in rooms)


def test_scan_model_matches_sketch_rooms_and_carries_sketch_results(tmp_path):
    settings = settings_for(tmp_path)
    store = Store(settings)
    context = Context("owner", store, settings)
    state = store.load(context.owner)
    import_blueprint(state, Blueprint.model_validate(sketch_model()))
    capture = save_bytes(context, "reference", "scan-capture-1.png", "image/png", PNG)
    state["snapshot"]["uploads"] = [capture]
    provider_state(state)["geometrySamples"] = [[-8, 0, -6], [0, 0, -6], [0, 0, 0], [1, 1, 1], [2, 1, 1], [2, 1, 2]]

    async def scenario():
        async with httpx.AsyncClient() as http:
            runner = ManagedRunner(context, GeminiClient("", http))
            early = runner.commit_result(state, {"itemId": "sketch-room-living", "status": "pass", "basis": "layout", "observed": "Living room visible with glazing as sketched", "reason": "Seen in capture", "evidenceIds": [capture["id"]]})
            assert early["status"] == "pass"
            observed = draft_model("scan")
            observed["rooms"] = [{**room, "id": "obs-" + room["id"], "adjacentRoomIds": ["obs-" + other for other in room["adjacentRoomIds"]], "designRoomId": room["id"]} for room in observed["rooms"][:4]]
            kept = {room["id"] for room in observed["rooms"]}
            for room in observed["rooms"]:
                room["adjacentRoomIds"] = [other for other in room["adjacentRoomIds"] if other in kept]
            observed["features"] = [{**feature, "id": "obs-" + feature["id"], "roomId": "obs-" + feature["roomId"]} for feature in observed["features"] if "obs-" + feature["roomId"] in kept]
            bad = deepcopy(observed)
            bad["rooms"][0]["designRoomId"] = "not-a-sketch-room"
            assert "error" in runner.create_spatial_model(state, {"blueprint": bad, "evidenceIds": [capture["id"]], "reason": "bad mapping"})
            result = runner.create_spatial_model(state, {"blueprint": observed, "evidenceIds": [capture["id"]], "reason": "Observed rooms from captures and depth"})
            assert result["saved"] and sorted(result["unmatchedSketchRooms"]) == sorted(room["name"] for room in sketch_model()["rooms"][4:])
            checklist = {item["id"]: item for item in state["snapshot"]["checklist"]}
            assert checklist["sketch-room-living"]["status"] == "pass" and checklist["sketch-room-living"]["roomId"] == "obs-living"
            unmatched = [item for item in checklist.values() if item["id"].startswith("sketch-room-") and item["roomId"] == "unassigned"]
            assert len(unmatched) == 2
            missing = runner.commit_result(state, {"itemId": unmatched[0]["id"], "status": "finding", "basis": "layout", "observed": "No such room is reachable from the hall", "reason": "Walked the hall; no opening where the sketch draws it", "evidenceIds": [capture["id"]], "finding": {"title": "Sketched room not found", "severity": "major", "expected": "Room as sketched", "nextAction": "Confirm with the owner whether the sketch is current"}})
            assert missing["status"] == "finding"
            finding = state["snapshot"]["findings"][-1]
            assert finding["category"] == "Sketch deviation" and finding["annotationSource"] == "reference"
            feature_check = "sketch-feature-" + sketch_model()["features"][0]["id"]
            drawn = runner.commit_result(state, {"itemId": feature_check, "status": "finding", "basis": "layout", "observed": "Opening is further along the wall", "reason": "Capture shows the opening offset", "evidenceIds": [capture["id"]], "finding": {"title": "Opening offset from sketch", "severity": "minor", "expected": "Opening as drawn", "nextAction": "Owner to confirm", "anchor": [1, 1, 1], "endAnchor": [2, 1, 1], "region": [[1, 1, 1], [2, 1, 1], [2, 1, 2]], "imageRegions": [{"evidenceId": capture["id"], "box": [0.1, 0.1, 0.5, 0.6]}, {"evidenceId": "someone-else", "box": [0, 0, 1, 1]}]}})
            assert sorted(drawn["drawn"]) == ["endAnchor", "imageRegions", "measurement", "region"]
            assert state["snapshot"]["findings"][-1]["measurement"]["units"] == "scene" and state["snapshot"]["findings"][-1]["measurement"]["value"] == 1.0
            finding = state["snapshot"]["findings"][-1]
            assert finding["endAnchor"] == [2, 1, 1] and len(finding["region"]) == 3 and len(finding["imageRegions"]) == 1
            assert "uncited" in finding["reason"]
            unsampled = runner.commit_result(state, {"itemId": feature_check, "status": "finding", "basis": "layout", "observed": "Opening is further along the wall", "reason": "Second look", "evidenceIds": [capture["id"]], "finding": {"title": "Opening offset from sketch", "severity": "minor", "expected": "Opening as drawn", "nextAction": "Owner to confirm", "anchor": [1, 1, 1], "endAnchor": [9, 9, 9]}})
            assert unsampled["drawn"] == [] and "endAnchor" not in state["snapshot"]["findings"][-1]
            report = report_data(state["snapshot"], state["designReference"])
            verification = report["sketchVerification"]
            assert verification["summary"]["claims"] == len([item for item in checklist.values() if item["id"].startswith("sketch-")])
            assert next(room for room in verification["rooms"] if room["id"] == "living")["status"] == "as sketched"
            assert any(room["status"] == "differs" for room in verification["rooms"])
            assert "Sketch verification" in report_html(state["snapshot"], "https://argon.example", state["designReference"])
    asyncio.run(scenario())


def test_relative_camera_move_and_trail(tmp_path):
    calls = []
    def handler(request):
        if request.method == "GET" and request.url.host == "superspl.at":
            return httpx.Response(200, text=bootstrap_html([1, 2, 3], [0, 1, 0]), headers={"content-type": "text/html"})
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return httpx.Response(200, json={"id": "walk-1", "status": "requires_action", "environment_id": "env-1", "steps": [{"id": "move-1", "type": "function_call", "name": "move_camera", "arguments": {"turn": 45, "forward": 1.5, "label": "Look toward the kitchen"}}]})
        if len(calls) == 2:
            assert body["input"][0]["call_id"] == "move-1" and body["input"][0]["result"]["cameraPosition"] == [1.5, 1.6, 0.2]
            return httpx.Response(200, json={"id": "walk-2", "status": "requires_action", "steps": [{"id": "move-2", "type": "function_call", "name": "move_camera", "arguments": {"label": "no movement"}}, {"id": "read-2", "type": "function_call", "name": "read_blueprint", "arguments": {}}]})
        assert [item["call_id"] for item in body["input"]] == ["move-2", "read-2"], "every pending call of a turn is answered in one continuation"
        assert "error" in body["input"][0]["result"] and "blueprint" in body["input"][1]["result"]
        return httpx.Response(200, json={"id": "walk-3", "status": "completed", "output_text": "Stopped after the invalid move."})
    with TestClient(create_app(settings_for(tmp_path, "key"), transport=httpx.MockTransport(handler)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as client:
        assert client.patch("/api/scene", json={"sourceUrl": SCENE_URL}).status_code == 200
        started = client.post("/api/inspection", json={"action": "start", "mode": "managed"}).json()
        pending = started["agent"]["pendingTool"]
        assert pending["name"] == "move_camera" and pending["args"]["turn"] == 45 and pending["args"]["forward"] == 1.5
        answered = client.post("/api/agent-tools/" + pending["id"], json={"cameraPosition": [1.5, 1.6, 0.2], "cameraTarget": [3, 1.6, 2]})
        assert answered.status_code == 200
        snapshot = client.get("/api/inspection").json()
        assert snapshot["trail"] == [[1.5, 1.6, 0.2]]
        assert snapshot["status"] == "incomplete" and snapshot["agent"].get("pendingTool") is None
    assert len(calls) == 3
