"""Reports, floor plan, and viewer links project the same saved finding IDs."""
from html import escape
from typing import Any, Dict, Optional
from urllib.parse import quote
from .state import iso


def h(value: Any) -> str:
    return escape(str(value) if value is not None else "", quote=True)


def sketch_verification(snapshot: Dict[str, Any], design: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Room-by-room comparison of the owner's sketch with what the audit recorded."""
    if not design:
        return None
    checks = {item["id"]: item for item in snapshot["checklist"]}
    observed = {room["id"]: room for room in snapshot["blueprint"]["rooms"]}
    matched = {room["designRoomId"]: room["id"] for room in snapshot["blueprint"]["rooms"] if room.get("designRoomId")}
    outcome = lambda item: "not checked" if item is None or item["status"] in ("pending", "observing") else "as sketched" if item["status"] == "pass" else "differs" if item["status"] == "finding" else "blocked"
    rooms = []
    for room in design["rooms"]:
        item = checks.get("sketch-room-" + room["id"])
        rooms.append({"id": room["id"], "name": room["name"], "level": room["level"], "matchedRoomId": matched.get(room["id"]), "matchedRoomName": observed.get(matched.get(room["id"], ""), {}).get("name"), "status": outcome(item), "findingId": (item or {}).get("findingId"), "observed": (item or {}).get("observed")})
    links = [{"id": item["id"], "label": item["label"], "status": outcome(item), "findingId": item.get("findingId")} for item in snapshot["checklist"] if item["id"].startswith("sketch-link-")]
    features = [{"id": item["id"], "label": item["label"], "status": outcome(item), "findingId": item.get("findingId"), "observed": item.get("observed")} for item in snapshot["checklist"] if item["id"].startswith("sketch-feature-")]
    extra = [{"id": room["id"], "name": room["name"]} for room in snapshot["blueprint"]["rooms"] if snapshot["blueprint"].get("generatedFrom") == "scan" and not room.get("designRoomId")]
    tally = lambda rows, status: sum(row["status"] == status for row in rows)
    everything = rooms + links + features
    return {"sketchName": design["name"], "frameNote": "Sketch and scan use different coordinate frames; the comparison is room by room, never a geometric overlay.", "rooms": rooms, "connections": links, "features": features, "extraObservedRooms": extra,
            "summary": {"claims": len(everything), "asSketched": tally(everything, "as sketched"), "differs": tally(everything, "differs"), "blocked": tally(everything, "blocked"), "notChecked": tally(everything, "not checked")}}


def run_diff(snapshot: Dict[str, Any], baseline: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """GitHub-style diff of checks, findings, and rooms between a kept run and the current state."""
    if not baseline:
        return {"available": False, "reason": "No earlier run is kept yet. Finish an audit, then choose Re-audit to compare the next run against it."}
    before_checks = {item["id"]: item for item in baseline["checklist"]}
    after_checks = {item["id"]: item for item in snapshot["checklist"]}
    rooms = {room["id"]: room["name"] for room in snapshot["blueprint"]["rooms"]}
    rooms.update({room["id"]: room["name"] for room in baseline["blueprint"]["rooms"] if room["id"] not in rooms})
    checks = []
    for check_id in sorted(set(before_checks) | set(after_checks), key=lambda key: (key not in before_checks, key)):
        before, after = before_checks.get(check_id), after_checks.get(check_id)
        if before and after:
            if before["status"] == after["status"] and before.get("observed") == after.get("observed"):
                continue
            kind = "changed" if before["status"] != after["status"] else "note"
        else:
            kind = "added" if after else "removed"
        item = after or before
        checks.append({"id": check_id, "label": item["label"], "room": rooms.get(item["roomId"], item["roomId"]), "kind": kind, "before": before["status"] if before else None, "after": after["status"] if after else None, "observedBefore": (before or {}).get("observed"), "observedAfter": (after or {}).get("observed"), "findingId": (after or {}).get("findingId")})
    before_findings = {item["id"]: item for item in baseline["findings"]}
    after_findings = {item["id"]: item for item in snapshot["findings"]}
    findings = []
    for finding_id in sorted(set(before_findings) | set(after_findings)):
        before, after = before_findings.get(finding_id), after_findings.get(finding_id)
        if before and after and before["status"] == after["status"] and before["severity"] == after["severity"] and before.get("observed") == after.get("observed"):
            continue
        item = after or before
        findings.append({"id": finding_id, "title": item["title"], "room": rooms.get(item["roomId"], item["roomId"]), "severity": item["severity"], "kind": "changed" if before and after else "added" if after else "removed", "before": before["status"] if before else None, "after": after["status"] if after else None})
    before_rooms = {room["id"] for room in baseline["blueprint"]["rooms"]}
    after_rooms = {room["id"] for room in snapshot["blueprint"]["rooms"]}
    room_rows = [{"id": room_id, "name": rooms.get(room_id, room_id), "kind": "added" if room_id in after_rooms else "removed"} for room_id in sorted(before_rooms ^ after_rooms)]
    pending = sum(item["status"] in ("pending", "observing") for item in snapshot["checklist"])
    return {"available": True, "baselineRun": baseline["number"], "currentRun": snapshot.get("run", baseline["number"] + 1), "baselineEndedAt": baseline["endedAt"], "baselineVerdict": baseline["verdict"], "currentVerdict": snapshot["verdict"],
            "summary": {"checksChanged": sum(row["kind"] == "changed" for row in checks), "checksAdded": sum(row["kind"] == "added" for row in checks), "checksRemoved": sum(row["kind"] == "removed" for row in checks), "findingsAdded": sum(row["kind"] == "added" for row in findings), "findingsRemoved": sum(row["kind"] == "removed" for row in findings), "findingsChanged": sum(row["kind"] == "changed" for row in findings), "roomsAdded": sum(row["kind"] == "added" for row in room_rows), "roomsRemoved": sum(row["kind"] == "removed" for row in room_rows), "stillPending": pending},
            "checks": checks, "findings": findings, "rooms": room_rows}


def report_data(snapshot: Dict[str, Any], design: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    checklist = snapshot["checklist"]
    rank = {"critical": 0, "major": 1, "minor": 2}
    return {
        "sketchVerification": sketch_verification(snapshot, design),
        "schemaVersion": "auditgon.inspection-report.v1", "inspectionRevision": snapshot["revision"], "exportedAt": iso(),
        "disclosure": "Synthetic demonstration reference, findings, dimensions, and annotations. Source-scan owner observations are separately labeled and unverified." if snapshot["blueprint"]["isSample"] else "Scoped visual inspection. Unobserved features and unvalidated metric measurements remain unresolved. The draft drawing is not a surveyed as-built.",
        "title": snapshot["name"], "inspectionId": snapshot["id"], "verdict": snapshot["verdict"], "status": snapshot["status"], "mode": snapshot["mode"], "elapsedSeconds": snapshot["elapsedSeconds"],
        "coverage": {"total": len(checklist), "verified": sum(item["status"] in ("pass", "finding") for item in checklist), "blocked": sum(item["status"] == "blocked" for item in checklist), "accountedFor": sum(item["status"] not in ("pending", "observing") for item in checklist)},
        "scan": snapshot["scan"], "blueprint": snapshot["blueprint"], "checklist": checklist, "findings": sorted(snapshot["findings"], key=lambda finding: rank[finding["severity"]]),
        "spatialModelProvenance": {"generatedFrom": snapshot["blueprint"].get("generatedFrom"), "coordinateFrame": snapshot["blueprint"].get("coordinateFrame", "reference"), "metricStatus": snapshot["blueprint"].get("metricStatus", "unmeasured"), "units": snapshot["blueprint"].get("units", "scene"), "isDraft": True, "hasModel": bool(snapshot["blueprint"]["rooms"])},
        "captureRequests": [{"itemId": item["id"], "roomId": item["roomId"], "request": item.get("reason") or "Capture sufficient evidence to resolve this item."} for item in checklist if item["status"] == "blocked"],
        "run": snapshot.get("run", 1), "runHistory": snapshot.get("runHistory", []),
        "path": snapshot["path"], "trail": snapshot.get("trail", []), "events": snapshot["events"], "corrections": snapshot["corrections"],
        "holdback": {"available": False, "reason": "No repair quotes, contract retention terms, or agreed valuation basis were supplied. No holdback amount has been fabricated."},
    }


def blueprint_3d_json(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    model = snapshot["blueprint"]
    return {"schemaVersion": "auditgon.blueprint-3d.v1", "inspectionId": snapshot["id"], "inspectionRevision": snapshot["revision"], "exportedAt": iso(), "isDraft": True,
            "generatedFrom": model.get("generatedFrom"), "coordinateFrame": model.get("coordinateFrame", "reference"), "units": model.get("units", "scene"), "metricStatus": model.get("metricStatus", "unmeasured"),
            "disclosure": "Actual generated room polygons and observed features from this audit. Unmeasured scene coordinates are not meters. Unknown heights and furnishing dimensions remain unknown; schematic display geometry is not a measurement.",
            "rooms": model["rooms"], "features": model["features"], "blueprint": model,
            "trail": snapshot.get("trail", []),
            "annotations": [{"id": finding["id"], "anchor": finding["anchor"], "endAnchor": finding.get("endAnchor"), "region": finding.get("region"), "annotationSource": finding.get("annotationSource", "reference"), "title": finding["title"], "status": finding["status"]} for finding in snapshot["findings"]]}


def blueprint_obj(snapshot: Dict[str, Any]) -> str:
    import math
    import re
    model = snapshot["blueprint"]
    units = model.get("units", "scene")
    lines = ["# AUDITGON draft3D blueprint", "# Units: " + units, "# Metric status: " + model.get("metricStatus", "unmeasured"), "# Coordinate frame: " + model.get("coordinateFrame", "reference"),
             "# Source: " + model.get("generatedFrom", "unspecified"), "# Inspection revision: " + str(snapshot["revision"]), "# Unmeasured scene coordinates are NOT meters or survey measurements.", "# Unknown room heights use schematic low cutaway walls of0.7 display units only; these are NOT actual wall heights."]
    if not model["rooms"]:
        lines.append("# No spatial model generated yet. No geometry has been invented.")
        return "\n".join(lines) + "\n"
    offset = 1

    def name(value):
        return re.sub(r"[^A-Za-z0-9_-]", "_", str(value))[:100]

    for room in model["rooms"]:
        floor = room.get("floorElevation", 0)
        height = room.get("height")
        visual_height = height if height is not None else 0.7
        polygon = room["polygon"]
        count = len(polygon)
        lines.extend(["o room_" + name(room["id"]), "# " + ("Supplied/derived height: " + str(height) + " " + units if height is not None else "UNKNOWN actual height; display-only0.7 cutaway")])
        if room.get("floorFinish") or room.get("wallFinish"):
            lines.append("# Observed finishes: floor {} {} · walls {} {}".format(room.get("floorFinish", "unknown"), room.get("floorColor", ""), room.get("wallFinish", "unknown"), room.get("wallColor", "")).strip())
        for y in (floor, floor + visual_height):
            lines.extend("v {:.6f} {:.6f} {:.6f}".format(point[0], y, point[1]) for point in polygon)
        lines.append("f " + " ".join(str(offset + index) for index in range(count)))
        for index in range(count):
            nxt = (index + 1) % count
            lines.append("f {} {} {} {}".format(offset + index, offset + nxt, offset + count + nxt, offset + count + index))
        offset += count * 2
    for feature in model["features"]:
        if feature["kind"] not in ("furniture", "island", "stair"):
            continue
        dimensions = feature.get("dimensions")
        if dimensions is None or any(value <= 0 for value in dimensions):
            lines.append("# Observed furniture {} has unknown dimensions; no bounding mesh fabricated.".format(name(feature["id"])))
            continue
        cx, cy, cz = feature["position"]
        width, height, depth = dimensions
        angle = math.radians(feature.get("rotation", 0))
        lines.extend(["o " + name(feature["kind"]) + "_" + name(feature["id"]), "# Observed " + name(feature.get("objectType", feature["kind"])) + " approximate bounding box; context geometry, not metrology."])
        for dy in (-height / 2, height / 2):
            for dx, dz in ((-width / 2, -depth / 2), (width / 2, -depth / 2), (width / 2, depth / 2), (-width / 2, depth / 2)):
                lines.append("v {:.6f} {:.6f} {:.6f}".format(cx + dx * math.cos(angle) + dz * math.sin(angle), cy + dy, cz - dx * math.sin(angle) + dz * math.cos(angle)))
        for face in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            lines.append("f " + " ".join(str(offset + vertex) for vertex in face))
        offset += 8
    return "\n".join(lines) + "\n"


def floorplan_svg(snapshot: Dict[str, Any], focus_finding_id: Optional[str] = None) -> str:
    points = [point for room in snapshot["blueprint"]["rooms"] for point in room["polygon"]]
    if not points:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400" viewBox="0 0 900 400" role="img" aria-label="Auditgon spatial model pending"><rect width="900" height="400" fill="#f6f8fc"/><text x="44" y="65" font-family="sans-serif" font-size="26" fill="#18498a">AUDITGON · Spatial model pending</text><text x="44" y="110" font-family="sans-serif" font-size="15" fill="#65748a">The audit will derive rooms and a draft3D blueprint from your scan and materials.</text><text x="44" y="150" font-family="sans-serif" font-size="13" fill="#65748a">No room geometry or measurements have been invented.</text></svg>'
    min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
    min_z, max_z = min(p[1] for p in points), max(p[1] for p in points)
    factor = min(760 / max(1, max_x - min_x), 500 / max(1, max_z - min_z))

    def xy(x, z):
        return (60 + (x - min_x) * factor, 105 + (z - min_z) * factor)

    rooms = []
    for room in snapshot["blueprint"]["rooms"]:
        items = [item for item in snapshot["checklist"] if item["roomId"] == room["id"]]
        findings = [finding for finding in snapshot["findings"] if finding["roomId"] == room["id"] and finding["status"] not in ("resolved", "dismissed")]
        color = "#fff0e7" if findings else "#fff9e4" if any(item["status"] == "blocked" for item in items) else "#eaf2e4" if items and all(item["status"] == "pass" for item in items) else "#f2f1ed"
        width = max(p[0] for p in room["polygon"]) - min(p[0] for p in room["polygon"])
        depth = max(p[1] for p in room["polygon"]) - min(p[1] for p in room["polygon"])
        cx, cz = xy(room["center"][0], room["center"][2])
        polygon = " ".join("{:.2f},{:.2f}".format(*xy(*point)) for point in room["polygon"])
        rooms.append('<polygon points="{}" fill="{}" stroke="#777a70" stroke-width="2" stroke-dasharray="7 4"/><text x="{:.2f}" y="{:.2f}" text-anchor="middle" fill="#373b30" font-size="13" font-weight="600">{}</text><text x="{:.2f}" y="{:.2f}" text-anchor="middle" fill="#777a70" font-size="10">{:.2f} × {:.2f} {} · {}</text>'.format(polygon, color, cx, cz, h(room["name"]), cx, cz + 19, width, depth, "scene units" if snapshot["blueprint"].get("units") == "scene" else "m", "sample" if snapshot["blueprint"]["isSample"] else "design reference"))
    path = '<polyline points="{}" fill="none" stroke="#78964c" stroke-width="2.5" stroke-dasharray="4 4"/>'.format(" ".join("{:.2f},{:.2f}".format(*xy(point[0], point[2])) for point in snapshot["path"])) if snapshot["path"] else ""
    markers = []
    for finding in snapshot["findings"]:
        if focus_finding_id and finding["id"] != focus_finding_id:
            continue
        if finding.get("annotationSource") == "scan" and snapshot["blueprint"].get("coordinateFrame") != "scan":
            continue  # Never project native scan points into an unregistered plan.
        x, z = xy(finding["anchor"][0], finding["anchor"][2])
        if finding.get("region"):
            markers.append('<polygon points="{}" fill="#bb562f33" stroke="#bb562f" stroke-width="2"/>'.format(" ".join("{:.2f},{:.2f}".format(*xy(point[0], point[2])) for point in finding["region"])))
        if finding.get("endAnchor"):
            ex, ez = xy(finding["endAnchor"][0], finding["endAnchor"][2])
            markers.append('<line x1="{:.2f}" y1="{:.2f}" x2="{:.2f}" y2="{:.2f}" stroke="#bb562f" stroke-width="4"/>'.format(x, z, ex, ez))
            if finding.get("measurement"):
                markers.append('<text x="{:.2f}" y="{:.2f}" text-anchor="middle" font-size="10" fill="#7e593d">≈ {} {}</text>'.format((x + ex) / 2, (z + ez) / 2 - 8, finding["measurement"]["value"], h(finding["measurement"]["units"])))
        markers.append('<g><title>{}</title><circle cx="{:.2f}" cy="{:.2f}" r="11" fill="{}" stroke="#fff" stroke-width="2"/><text x="{:.2f}" y="{:.2f}" text-anchor="middle" font-size="9" fill="#fff">{}</text></g>'.format(h(finding["id"] + ": " + finding["title"] + ". " + finding["reason"]), x, z, "#78964c" if finding["status"] == "resolved" else "#c26438", x, z + 3, h(finding["id"].replace("F-00", ""))))
    title = "Sample reference model" if snapshot["blueprint"]["isSample"] else "Draft generated floor plan"
    return '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="730" viewBox="0 0 900 730" role="img" aria-label="Auditgon draft reference floor plan"><rect width="900" height="730" rx="14" fill="#faf9f5"/><text x="42" y="40" fill="#2f3526" font-family="sans-serif" font-size="23" font-weight="600">AUDITGON · {}</text><text x="42" y="66" fill="#777a70" font-family="sans-serif" font-size="12">{} · revision {} · {}</text><g font-family="sans-serif">{}{}{}</g><text x="42" y="660" fill="#7e593d" font-family="sans-serif" font-size="12">Dashed outlines: intended / unmeasured geometry. No surveyed as-built geometry available.</text><text x="42" y="683" fill="#777a70" font-family="sans-serif" font-size="11">Source pins appear here only when their coordinate frame matches this model.</text><text x="42" y="706" fill="#777a70" font-family="sans-serif" font-size="10">{}</text></svg>'.format(title, h(snapshot["blueprint"]["name"]), snapshot["revision"], "scene units" if snapshot["blueprint"].get("units") == "scene" else "meters", "".join(rooms), path, "".join(markers), h("Synthetic reference geometry; no source-residence measurements." if snapshot["blueprint"]["isSample"] else "Scan measurement accuracy remains independently unvalidated; no centimeter claims."))


def finding_html(finding, origin):
    link = origin + "/?finding=" + quote(finding["id"], safe="") + "&view=inspection"
    evidence = "".join("<li><b>{}:</b> {}{}</li>".format(h(item["label"]), h(item["description"]), ' <a href="{}">Open saved evidence</a>'.format(h(origin + item["imageUrl"])) if item.get("imageUrl", "").startswith("/api/uploads/") else "") for item in finding["evidence"])
    rule = "<p><b>Rule / specification:</b> {}. {}</p>".format(h(finding["rule"]["label"]), h(finding["rule"]["applicability"])) if finding.get("rule") else ""
    note = "<p><b>Owner note:</b> {}</p>".format(h(finding["note"])) if finding.get("note") else ""
    if finding.get("measurement"):
        note = "<p><b>Marked span:</b> ≈ {} {} · {} {}</p>".format(finding["measurement"]["value"], h(finding["measurement"]["units"]), h(finding["measurement"]["method"]), h(finding["measurement"]["uncertainty"])) + note
    return '<article id="{}"><div class="meta">{} · {} · {}{}</div><h3>{}</h3><p>{}</p><dl><dt>Expected</dt><dd>{}</dd><dt>Observed</dt><dd>{}</dd><dt>Uncertainty</dt><dd>{}</dd><dt>Next action</dt><dd>{}</dd></dl>{}<p><a href="{}">Show in 3D / reference model →</a></p><ul>{}</ul>{}</article>'.format(h(finding["id"]), h(finding["id"]), h(finding["severity"]), h(finding["status"]), " · SAMPLE" if finding["isSample"] else " · SOURCE OBSERVATION", h(finding["title"]), h(finding["reason"]), h(finding["expected"]), h(finding["observed"]), h(finding.get("uncertainty", "Not quantified")), h(finding["nextAction"]), rule, h(link), evidence, note)


def sketch_html(verification: Optional[Dict[str, Any]]) -> str:
    if not verification:
        return "<p>No sketch was supplied. The audit verified visible scope only.</p>"
    rows = "".join("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(h(kind), h(row.get("name") or row["label"]), h(row.get("matchedRoomName") or ("—" if kind == "Room" else "")), h(row["status"]) + (" · " + h(row["findingId"]) if row.get("findingId") else ""))
                   for kind, rows_ in (("Room", verification["rooms"]), ("Connection", verification["connections"]), ("Feature", verification["features"])) for row in rows_)
    extra = "".join("<li>{}</li>".format(h(room["name"])) for room in verification["extraObservedRooms"])
    summary = verification["summary"]
    return '<p>{} · {} claims: {} as sketched, {} differ, {} blocked, {} not checked.</p><p class="meta">{}</p><table><thead><tr><th>Sketched</th><th>Item</th><th>Observed room</th><th>Outcome</th></tr></thead><tbody>{}</tbody></table>{}'.format(
        h(verification["sketchName"]), summary["claims"], summary["asSketched"], summary["differs"], summary["blocked"], summary["notChecked"], h(verification["frameNote"]), rows, "<p>Observed rooms not in the sketch:</p><ul>" + extra + "</ul>" if extra else "")


def report_html(snapshot: Dict[str, Any], origin: str, design: Optional[Dict[str, Any]] = None) -> str:
    report = report_data(snapshot, design)
    rooms = {room["id"]: room["name"] for room in snapshot["blueprint"]["rooms"]}
    rows = "".join("<tr><td>{}</td><td>{}<br/>{}</td><td>{}</td><td>{}</td></tr>".format(h(item["id"]), h(rooms.get(item["roomId"], item["roomId"])), h(item["label"]), h(item["status"]), h(item.get("observed") or item.get("reason") or "Not inspected")) for item in snapshot["checklist"])
    captures = "<ul>" + "".join("<li><b>{} · {}:</b> {}</li>".format(h(rooms.get(item["roomId"], item["roomId"])), h(item["itemId"]), h(item["request"])) for item in report["captureRequests"]) + "</ul>" if report["captureRequests"] else "<p>No blocked capture requests recorded. Pending scope remains in the checklist.</p>"
    findings = "".join(finding_html(finding, origin) for finding in report["findings"]) or "<p>No evidence-backed findings have been recorded.</p>"
    metrics = "".join("<div><b>{}</b>{}</div>".format(h(value), label) for value, label in [(snapshot["verdict"], "Scoped verdict"), ("{}/{}".format(report["coverage"]["verified"], report["coverage"]["total"]), "Verified checks"), (report["coverage"]["blocked"], "Blocked checks"), (sum(finding["status"] in ("open", "review") for finding in report["findings"]), "Active findings")])
    return '''<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Auditgon inspection · TITLE</title><style>body{margin:0 auto;max-width:960px;padding:44px 30px;background:#faf9f5;color:#30352b;font:15px/1.6 Arial,sans-serif}h1{font-size:40px;letter-spacing:-1.5px;line-height:1.1}h2{font-size:25px;margin-top:40px}.eyebrow,.meta{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#69735b}.disclosure{background:#f0e9d8;padding:15px;border-left:3px solid #b9863d}.metrics{display:flex;flex-wrap:wrap;gap:26px;margin:26px 0}.metrics b{font-size:25px;display:block}article{border-top:1px solid #dedfd5;padding:22px 0;break-inside:avoid}h3{margin:6px 0;font-size:21px}dl{display:grid;grid-template-columns:100px 1fr;gap:6px 18px}dt{color:#6b725e}dd{margin:0}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:10px 7px;border-bottom:1px solid #e0e1d9;text-align:left}a{color:#627a3c}svg{width:100%;height:auto}.button{border:0;background:#d4ed8f;padding:12px 20px;border-radius:5px;cursor:pointer}@media print{body{background:white;padding:0}.button{display:none}h2{break-after:avoid}a{color:inherit}table{font-size:10px}}</style></head><body>BODY</body></html>'''.replace("TITLE", h(snapshot["name"])).replace("BODY", '<div class="eyebrow">ARGON / Inspection record · revision {}</div><h1>{}</h1><p>{}</p><p class="disclosure">{}</p><div class="metrics">{}</div><p>Elapsed active time: {} min {} sec. Exported {}.</p><button class="button" onclick="window.print()">Print / save PDF</button><h2>Sketch verification</h2>{}<h2>Reference & coverage map</h2>{}<h2>Punch list</h2>{}<h2>Required additional captures</h2>{}<h2>Full checklist</h2><table><thead><tr><th>ID</th><th>Room / item</th><th>Status</th><th>Observation</th></tr></thead><tbody>{}</tbody></table><h2>Cost & payment retention</h2><p>{}</p><h2>Provenance</h2><p>Source scan: <a href="{}">{}</a>. Blueprint: {} ({}). Findings, pins and report use the same saved revision. This reference draft has no surveyed as-built geometry.</p>'.format(snapshot["revision"], h(snapshot["name"]), h(snapshot["address"]), h(report["disclosure"]), metrics, snapshot["elapsedSeconds"] // 60, snapshot["elapsedSeconds"] % 60, h(report["exportedAt"]), sketch_html(report["sketchVerification"]), floorplan_svg(snapshot), findings, captures, rows, h(report["holdback"]["reason"]), h(snapshot["scan"]["sourceUrl"]), h(snapshot["scan"]["name"]), h(snapshot["blueprint"]["name"]), h(snapshot["blueprint"]["revision"])))
