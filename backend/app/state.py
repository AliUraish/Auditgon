"""Pure inspection state transitions. No sleeps or manufactured elapsed time."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
import json
import re
import time
import uuid
from .errors import ApiFailure
from .models import Blueprint, DiscoveredItem, FindingPatch, ManualFinding

State = Dict[str, Any]
Snapshot = Dict[str, Any]
SAMPLE = json.loads((Path(__file__).parent / "sample.json").read_text())


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(now: Optional[int] = None) -> str:
    return datetime.fromtimestamp((now if now is not None else now_ms()) / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def uid() -> str:
    return str(uuid.uuid4())


def sample_state(now: Optional[int] = None) -> State:
    current = now_ms() if now is None else now
    snapshot = deepcopy(SAMPLE)
    snapshot.update(id=uid(), createdAt=iso(current), updatedAt=iso(current), startedAt=None, elapsedSeconds=0, revision=1)
    for finding in snapshot["findings"]:
        finding["createdAt"] = finding["updatedAt"] = iso(current)
        for history in finding["history"]:
            history["at"] = iso(current)
    for entry in snapshot["events"]:
        entry["at"] = iso(current)
        entry["id"] = uid()
    return {"snapshot": snapshot, "elapsedMs": 0, "activeSince": None, "projectVersion": 2}


def empty_blueprint() -> Dict[str, Any]:
    return {"id": "uncreated-model", "name": "Spatial model not created yet", "revision": "pending", "units": "scene", "isSample": False, "rooms": [], "features": [], "metricStatus": "unmeasured"}


def initial_state(now: Optional[int] = None) -> State:
    current = now_ms() if now is None else now
    return {"projectVersion": 2, "elapsedMs": 0, "activeSince": None, "snapshot": {
        "id": uid(), "name": "Untitled audit", "address": "Add a scan and any reference materials", "mode": "managed", "status": "ready", "createdAt": iso(current), "updatedAt": iso(current), "startedAt": None, "elapsedSeconds": 0,
        "currentRoomId": "", "currentItemId": None, "blueprint": empty_blueprint(), "checklist": [], "findings": [], "events": [], "uploads": [], "path": [], "trail": [], "agents": [], "corrections": 0, "revision": 1, "verdict": "Incomplete",
        "scan": {"sourceUrl": "", "assetUrl": None, "name": "No scan selected", "calibrated": False, "scale": 1, "version": "unconfigured", "configured": False, "posterUrl": None},
        "capabilities": {"managedAgent": False, "uploads": True, "persistence": True, "providerMessage": "Add a scan link and optional materials to begin."},
    }}


def migrate_legacy_sample(state: State) -> bool:
    """Remove old bootstrap examples once, preserving actual owner inputs."""
    if state.get("projectVersion", 0) >= 2:
        return False
    snapshot = state["snapshot"]
    state["projectVersion"] = 2
    if not snapshot.get("blueprint", {}).get("isSample"):
        return True
    real_findings = [finding for finding in snapshot.get("findings", []) if not finding.get("isSample", True)]
    uploads = snapshot.get("uploads", [])
    previous_id, revision = snapshot["id"], snapshot["revision"]
    old_scan = snapshot.get("scan", {})
    empty = initial_state()
    empty["snapshot"].update(id=previous_id, revision=revision, uploads=uploads, findings=real_findings)
    if real_findings or uploads:
        empty["snapshot"]["scan"] = {**old_scan, "configured": bool(old_scan.get("assetUrl") or old_scan.get("sourceUrl"))}
    for finding in real_findings:
        finding["roomId"] = "unassigned"
        empty["snapshot"]["checklist"].append({"id": finding["itemId"], "roomId": "unassigned", "label": finding["title"], "category": finding["category"], "status": "blocked", "anchor": finding["anchor"], "findingId": finding["id"], "reason": "Preserved owner observation; spatial model and verification pending."})
    state.clear()
    state.update(empty)
    return True


def replace_scene(state: State, scan: Dict[str, Any]) -> None:
    """Keep materials, invalidate all geometry/results from the previous house."""
    old = state["snapshot"]
    fresh = initial_state()
    fresh["snapshot"].update(revision=old["revision"], uploads=old["uploads"], scan=scan, name=scan.get("name") or "New property audit", address="Scan selected · spatial discovery pending")
    state.clear()
    state.update(fresh)
    event(state, "system", "New scan selected", "Previous house geometry, findings, and audit results were cleared. Attached materials remain available.", {"isSample": False})


def elapsed_seconds(state: State, now: Optional[int] = None) -> int:
    current = now_ms() if now is None else now
    active = state.get("activeSince")
    return int((state["elapsedMs"] + (max(0, current - active) if active is not None else 0)) // 1000)


def stop_clock(state: State, now: Optional[int] = None) -> None:
    current = now_ms() if now is None else now
    if state.get("activeSince") is not None:
        state["elapsedMs"] += max(0, current - state["activeSince"])
    state["activeSince"] = None
    state["snapshot"]["elapsedSeconds"] = elapsed_seconds(state, current)


def event(state: State, kind: str, title: str, detail: str, extra: Optional[Dict[str, Any]] = None, now: Optional[int] = None) -> None:
    state["snapshot"]["events"].append({"id": uid(), "at": iso(now), "kind": kind, "title": title, "detail": detail,
                                           "isSample": state["snapshot"]["mode"] == "demo", **(extra or {})})
    state["snapshot"]["events"] = state["snapshot"]["events"][-160:]


def verdict(snapshot: Snapshot) -> str:
    if not snapshot.get("blueprint", {}).get("rooms") or not snapshot.get("checklist"):
        return "Incomplete"
    if any(item["status"] in ("pending", "observing", "blocked") for item in snapshot["checklist"]):
        return "Incomplete"
    active = [finding for finding in snapshot["findings"] if finding["status"] in ("open", "review")]
    if any(finding["severity"] in ("major", "critical") for finding in active):
        return "Fail"
    return "Pass with notes" if active else "Pass"


def finalize(state: State, now: Optional[int] = None) -> None:
    stop_clock(state, now)
    snapshot = state["snapshot"]
    snapshot["verdict"] = verdict(snapshot)
    snapshot["status"] = "incomplete" if snapshot["verdict"] == "Incomplete" else "complete"
    snapshot["currentItemId"] = None
    event(state, "verify", "Inspection checkpoint finalized", snapshot["verdict"] + ". Unverified and blocked items remain visible in the report.", now=now)


def start_demo(state: State, now: Optional[int] = None) -> None:
    current = now_ms() if now is None else now
    snapshot = state["snapshot"]
    if not snapshot["blueprint"]["isSample"]:
        raise ApiFailure(409, "The demo runs only on the labeled sample plan. Reset to the sample workspace or use Managed Agents.", "SAMPLE_ONLY")
    if snapshot["status"] == "running":
        return
    if snapshot["status"] == "complete":
        raise ApiFailure(409, "This run is complete. Reset the workspace to run the sample again.", "RUN_COMPLETE")
    snapshot.update(mode="demo", status="running", startedAt=snapshot.get("startedAt") or iso(current))
    state["activeSince"] = current
    event(state, "plan", "Sample inspection running", "Advancing illustrative checks. Elapsed time is measured from real active timestamps; it is never padded.", now=current)


def advance_demo(state: State, now: Optional[int] = None) -> None:
    snapshot = state["snapshot"]
    if snapshot["status"] != "running":
        return
    item = next((item for item in snapshot["checklist"] if item["status"] == "observing"), None)
    item = item or next((item for item in snapshot["checklist"] if item["status"] == "pending"), None)
    if item is None:
        finalize(state, now)
        return
    snapshot.update(currentItemId=item["id"], currentRoomId=item["roomId"])
    if item["status"] == "pending":
        item["status"] = "observing"
        room = next(room for room in snapshot["blueprint"]["rooms"] if room["id"] == item["roomId"])
        if not snapshot["path"] or snapshot["path"][-1][::2] != room["center"][::2]:
            snapshot["path"].append(deepcopy(room["center"]))
        snapshot["path"] = snapshot["path"][-400:]
        event(state, "navigate", "Reviewing " + item["label"].lower(), "Sample reference model · " + room["name"] + ". This demo does not measure the supplied residence.", {"roomId": item["roomId"], "itemId": item["id"]}, now)
    else:
        item.update(status="pass", observed="Synthetic example verified against sample reference; no measurement of the source residence.")
        event(state, "verify", item["label"] + " · sample verified", item["observed"], {"roomId": item["roomId"], "itemId": item["id"]}, now)
    snapshot["verdict"] = verdict(snapshot)


def import_blueprint(state: State, blueprint: Blueprint, now: Optional[int] = None) -> None:
    stop_clock(state, now)
    model = blueprint.model_dump(mode="json", exclude_none=True)
    model.setdefault("generatedFrom", "materials")
    model.setdefault("coordinateFrame", "reference")
    model.setdefault("metricStatus", "design-dimensions" if any("expected" in feature for feature in model["features"]) else "unmeasured")
    snapshot = state["snapshot"]
    snapshot.update(blueprint=model, name=model["name"], address="Imported sample reference" if model["isSample"] else "Independent blueprint · scan calibration pending",
                    status="ready", mode="demo" if model["isSample"] else "managed", startedAt=None, elapsedSeconds=0,
                    findings=[], events=[], path=[], corrections=0, currentRoomId=model["rooms"][0]["id"], currentItemId=None, verdict="Incomplete")
    snapshot.pop("agent", None)
    state.pop("provider", None)
    state["elapsedMs"] = 0
    previous_checks = snapshot.get("checklist", [])
    if model["generatedFrom"] == "materials":
        state["designReference"] = deepcopy(model)
        design, room_map, carry = model, {room["id"]: room["id"] for room in model["rooms"]}, {}
    elif state.get("designReference"):
        design = state["designReference"]
        room_map = {room["designRoomId"]: room["id"] for room in model["rooms"] if room.get("designRoomId")}
        carry = {item["id"]: item for item in previous_checks}
    else:
        design, room_map, carry = None, {}, {}
    if model["generatedFrom"] == "scan" and not carry:
        carry = {item["id"]: item for item in previous_checks}
    snapshot["scan"]["calibrated"] = False
    snapshot["checklist"] = [{"id": "check-" + feature["id"], "roomId": feature["roomId"], "label": feature["label"], "category": feature["kind"], "status": "pending", "anchor": feature["position"],
                              "expected": "{} {}{}".format(feature["expected"], feature.get("unit", model["units"]), " · " + feature["source"] if feature.get("source") else "")} for feature in model["features"] if feature["kind"] != "furniture" and "expected" in feature]
    for room in model["rooms"]:
        snapshot["checklist"].extend([
            {"id": "visual-" + room["id"], "roomId": room["id"], "label": room["name"] + ": visible workmanship", "category": "Workmanship", "status": "pending", "anchor": room["center"], "expected": "Review visible finish, trim, covers, and hardware. Confirm candidates with useful photographs; not-visible does not mean missing."},
            {"id": "coverage-" + room["id"], "roomId": room["id"], "label": room["name"] + ": visual coverage", "category": "Visibility", "status": "pending", "anchor": room["center"], "expected": "Obtain useful views, document visible and occluded areas, and request missing captures."},
        ])
    if design is not None:
        snapshot["checklist"].extend(sketch_checks(design, model, room_map, carry))
    if model["generatedFrom"] == "scan":
        # A model revision keeps every earlier result by ID and keeps discovered checks whose room still exists.
        present = {item["id"] for item in snapshot["checklist"]}
        rooms_now = {room["id"] for room in model["rooms"]}
        for item in snapshot["checklist"]:
            saved = carry.get(item["id"])
            if saved:
                for key in ("status", "observed", "reason", "findingId", "previousStatus", "changed"):
                    if key in saved:
                        item[key] = saved[key]
        for previous in previous_checks:
            if previous["id"].startswith("discovered-") and previous["id"] not in present and previous["roomId"] in rooms_now:
                snapshot["checklist"].append(previous)
    snapshot["checklist"] = snapshot["checklist"][:600]
    detail = "{} rooms and {} features from {}.".format(len(model["rooms"]), len(model["features"]), model["generatedFrom"])
    if design is not None and model["generatedFrom"] == "scan":
        detail += " {} of {} sketched rooms matched to observed rooms; sketch checks carried over.".format(len(room_map), len(design["rooms"]))
    elif design is not None:
        detail += " Sketch verification checks generated for every drawn room, connection, and feature."
    event(state, "plan", "Sketch reference imported" if model["generatedFrom"] == "materials" else "Spatial model imported", detail + " Previous results were removed. Extracted locations need review; no construction has been verified.", now=now)


def attach_design_reference(state: State, blueprint: Blueprint, now: Optional[int] = None) -> None:
    """A sketch arriving after the observed model exists becomes the design reference without discarding results."""
    model = blueprint.model_dump(mode="json", exclude_none=True)
    model.update(generatedFrom="materials", coordinateFrame="reference")
    model.setdefault("metricStatus", "design-dimensions" if any("expected" in feature for feature in model["features"]) else "unmeasured")
    state["designReference"] = deepcopy(model)
    snapshot = state["snapshot"]
    room_map = {room["designRoomId"]: room["id"] for room in snapshot["blueprint"]["rooms"] if room.get("designRoomId")}
    carry = {item["id"]: item for item in snapshot["checklist"]}
    kept = [item for item in snapshot["checklist"] if not item["id"].startswith("sketch-")]
    snapshot["checklist"] = (kept + sketch_checks(model, snapshot["blueprint"], room_map, carry))[:600]
    snapshot["verdict"] = verdict(snapshot)
    state.setdefault("provider", {"appliedIds": [], "executedCalls": [], "pollAfter": 0, "rounds": 0})["notice"] = "The owner attached a sketch during the run: {} new sketch- claims were added to the checklist. Call read_blueprint, revise create_spatial_model with designRoomId on each observed room that matches a sketched room, then record every sketch- claim as pass (as sketched) or finding (differs or missing) with cited captures.".format(len([item for item in snapshot["checklist"] if item["id"].startswith("sketch-")]))
    event(state, "plan", "Sketch reference attached", "{} sketched rooms and {} features now have verification claims. The observed model and existing findings are kept; Argon matches rooms on its next model revision.".format(len(model["rooms"]), len(model["features"])), now=now)


def patch_finding(state: State, finding_id: str, patch: FindingPatch, now: Optional[int] = None) -> None:
    snapshot = state["snapshot"]
    finding = next((finding for finding in snapshot["findings"] if finding["id"] == finding_id), None)
    if finding is None:
        raise ApiFailure(404, "Finding not found in this workspace.", "NOT_FOUND")
    old_status = finding["status"]
    if patch.status is not None:
        finding["status"] = patch.status
    if patch.note is not None:
        finding["note"] = patch.note
    finding["updatedAt"] = iso(now)
    finding["history"].append({"at": iso(now), "status": finding["status"], "note": patch.note or "Review status changed from {} to {}.".format(old_status, finding["status"])})
    finding["history"] = finding["history"][-40:]
    snapshot["verdict"] = verdict(snapshot)
    event(state, "verify", finding_id + " · " + finding["status"], patch.note or "Owner review status updated. Original measurement and evidence preserved.", {"roomId": finding["roomId"], "itemId": finding["itemId"]}, now)


def add_manual_finding(state: State, data: ManualFinding) -> None:
    snapshot = state["snapshot"]
    room = next((room for room in snapshot["blueprint"]["rooms"] if room["id"] == data.roomId), None)
    if room is None and not (data.roomId == "unassigned" and data.annotationSource == "scan"):
        raise ApiFailure(400, "Choose a room in the current reference.", "INVALID_ROOM_REFERENCE")
    if len(snapshot["findings"]) >= 300 or len(snapshot["checklist"]) >= 600:
        raise ApiFailure(413, "This workspace has reached its finding limit.", "WORKSPACE_LIMIT")
    item = next((item for item in snapshot["checklist"] if item["id"] == data.itemId), None) if data.itemId else None
    if data.itemId and (item is None or item["roomId"] != data.roomId):
        raise ApiFailure(400, "Choose an inspection item in this room.", "INVALID_ITEM_REFERENCE")
    if item is None:
        item = {"id": "manual-" + uid()[:8], "roomId": data.roomId, "label": data.title, "category": data.category, "status": "blocked", "anchor": list(data.anchor)}
        snapshot["checklist"].append(item)
    finding_id, timestamp = "F-" + uid()[:8], iso()
    finding = {"id": finding_id, "itemId": item["id"], "roomId": data.roomId, "title": data.title, "category": data.category, "severity": data.severity, "status": "review", "reason": data.reason,
               "expected": data.expected, "observed": data.observed, "nextAction": data.nextAction, "anchor": list(data.anchor),
               "cameraPosition": list(data.cameraPosition) if data.cameraPosition else [data.anchor[0] + 2, data.anchor[1] + 1.7, data.anchor[2] + 2], "cameraTarget": list(data.cameraTarget or data.anchor),
               "uncertainty": data.uncertainty or ("Owner-picked point in the source scan; approximate reconstructed surface. Room assignment and blueprint alignment remain unverified." if data.annotationSource == "scan" else "Owner reference-model observation awaiting evidence. Source scan registration remains unverified."),
               "evidence": [], "annotationSource": data.annotationSource, "isSample": False if data.annotationSource == "scan" else snapshot["blueprint"]["isSample"], "createdAt": timestamp, "updatedAt": timestamp,
               "history": [{"at": timestamp, "status": "review", "note": "Owner placed an unverified {} marker. Supporting evidence and verification are still required.".format(data.annotationSource)}]}
    if data.endAnchor:
        finding["endAnchor"] = list(data.endAnchor)
    snapshot["findings"].append(finding)
    item.update(findingId=finding_id, status="blocked", reason="Owner observation requires supporting capture and verification.")
    snapshot["verdict"] = verdict(snapshot)
    event(state, "finding", finding_id + " · owner observation", data.reason, {"roomId": data.roomId, "itemId": item["id"]})


def sketch_checks(design: Dict[str, Any], model: Dict[str, Any], room_map: Dict[str, str], carry: Dict[str, Dict[str, Any]]) -> list:
    """Verification items for every sketched room, connection, and feature, mapped onto observed rooms when matched."""
    observed = {room["id"]: room for room in model["rooms"]}
    names = {room["id"]: room["name"] for room in design["rooms"]}
    identity = all(room_map.get(room["id"]) == room["id"] for room in design["rooms"])

    def place(design_room_id: str):
        mapped = room_map.get(design_room_id)
        if mapped in observed:
            return mapped, list(observed[mapped]["center"])
        return "unassigned", [0, 0, 0]

    def item(check_id, design_room_id, label, category, expected, anchor=None):
        room_id, center = place(design_room_id)
        entry = {"id": check_id, "roomId": room_id, "designRoomId": design_room_id, "label": label, "category": category, "status": "pending", "anchor": anchor or center, "expected": expected}
        if room_id == "unassigned":
            entry["reason"] = "No observed room has been matched to this sketched room yet."
        saved = carry.get(check_id)
        if saved:
            for key in ("status", "observed", "reason", "findingId"):
                if key in saved:
                    entry[key] = saved[key]
        return entry

    items = []
    for room in design["rooms"]:
        items.append(item("sketch-room-" + room["id"], room["id"], room["name"] + ": exists as sketched", "Layout", "The sketch shows {} ({}). Confirm a corresponding space is visible in the scan and record how it differs.".format(room["name"], room["level"]), list(room["center"]) if identity else None))
    seen = set()
    for room in design["rooms"]:
        for other in room["adjacentRoomIds"]:
            pair = tuple(sorted((room["id"], other)))
            if pair in seen or other not in names:
                continue
            seen.add(pair)
            items.append(item("sketch-link-" + pair[0] + "-" + pair[1], room["id"], "{} connects to {} as sketched".format(names[pair[0]], names[pair[1]]), "Layout", "The sketch draws an opening or passage between these rooms. Confirm it by moving through it or seeing both sides."))
    for feature in design["features"]:
        if feature["kind"] == "furniture":
            continue
        note = " A written dimension is checked separately and stays blocked without calibration." if "expected" in feature else ""
        items.append(item("sketch-feature-" + feature["id"], feature["roomId"], "{}: present where sketched".format(feature["label"]), "Presence", "Sketched in {}. Confirm the {} exists at the drawn location and mark it in the scan.{}".format(names.get(feature["roomId"], feature["roomId"]), feature["kind"], note), list(feature["position"]) if identity else None))
    return items


def start_reaudit(state: State, now: Optional[int] = None) -> Dict[str, Any]:
    """Freeze the current results as a numbered run, then reopen every check for re-verification in place."""
    snapshot = state["snapshot"]
    if not snapshot["blueprint"]["rooms"] and not snapshot["checklist"]:
        raise ApiFailure(409, "Nothing to re-audit yet. Run the first audit before asking for changes.", "NO_BASELINE")
    if snapshot["status"] == "running":
        raise ApiFailure(409, "Pause or finish the current audit before starting a re-audit.", "RUN_ACTIVE")
    stop_clock(state, now)
    number = snapshot.get("run", 1)
    baseline = {"id": uid(), "number": number, "endedAt": iso(now), "startedAt": snapshot.get("startedAt"), "verdict": snapshot["verdict"], "status": snapshot["status"], "elapsedSeconds": snapshot["elapsedSeconds"],
                "checklist": deepcopy(snapshot["checklist"]), "findings": deepcopy(snapshot["findings"]), "blueprint": deepcopy(snapshot["blueprint"]), "trail": deepcopy(snapshot.get("trail", [])), "agents": []}
    state["runs"] = (state.get("runs", []) + [baseline])[-5:]
    snapshot["runHistory"] = (snapshot.get("runHistory", []) + [{"number": number, "endedAt": baseline["endedAt"], "verdict": baseline["verdict"], "checks": len(baseline["checklist"]), "findings": len(baseline["findings"]), "rooms": len(baseline["blueprint"]["rooms"])}])[-5:]
    snapshot["run"] = number + 1
    for item in snapshot["checklist"]:
        # Results stay visible; Argon re-verifies in place and only differences show in the diff.
        item["previousStatus"] = item["status"]
        item.pop("changed", None)
    baseline["agents"] = deepcopy(snapshot.get("agents", []))
    snapshot["agents"] = []
    snapshot.update(status="ready", currentItemId=None, startedAt=None, elapsedSeconds=0)
    snapshot.pop("agent", None)
    state.pop("provider", None)
    state["elapsedMs"] = 0
    state["activeSince"] = None
    event(state, "plan", "Re-audit {} started".format(number + 1), "Run {} is kept as the baseline. Every check is re-verified in place; only changes are reported in the diff.".format(number), now=now)
    return baseline


def record_camera(state: State, position) -> None:
    """Keep a bounded trail of real camera positions reported by the browser."""
    if not position:
        return
    trail = state["snapshot"].setdefault("trail", [])
    point = [float(value) for value in position]
    if not trail or trail[-1] != point:
        trail.append(point)
    state["snapshot"]["trail"] = trail[-200:]


def add_inspection_item(state: State, data: DiscoveredItem) -> Dict[str, Any]:
    snapshot = state["snapshot"]
    room = next((room for room in snapshot["blueprint"]["rooms"] if room["id"] == data.roomId), None)
    if room is None:
        return {"error": "Unknown room; use read_blueprint."}
    normalize = lambda label: re.sub(r"[^a-z0-9]", "", label.lower())
    existing = next((item for item in snapshot["checklist"] if item["roomId"] == data.roomId and normalize(item["label"]) == normalize(data.label)), None)
    if existing:
        return {"itemId": existing["id"], "existing": True}
    if len(snapshot["checklist"]) >= 600 or sum(item["id"].startswith("discovered-") and item["roomId"] == room["id"] for item in snapshot["checklist"]) >= 20:
        return {"error": "The discovered-item scope budget has been reached."}
    item = {"id": "discovered-" + uid()[:12], "roomId": room["id"], "label": data.label, "category": data.category, "status": "pending", "anchor": room["center"], "expected": "Visual workmanship / coverage review; no inferred numeric design requirement.", "reason": data.reason}
    snapshot["checklist"].append(item)
    snapshot["verdict"] = "Incomplete"
    event(state, "plan", "Agent expanded inspection scope", room["name"] + ": " + data.label + ". " + data.reason, {"roomId": room["id"], "itemId": item["id"]})
    return {"itemId": item["id"], "existing": False}
