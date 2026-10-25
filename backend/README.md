# Auditgon Python backend

FastAPI serves the input-first audit API and the built React frontend from `../frontend/dist`. Python3.9 or newer is supported. Data persists in `backend/data/argon.db` and private files under `backend/data/uploads`; no Cloudflare or Node backend is required.

From the repository root:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --no-proxy-headers --workers 1
```

Vite proxies `/api` to port8000 during development. Build `frontend/` and serve through FastAPI for one-origin production. Use one worker and a persistent data volume when hosting.

```sh
backend/.venv/bin/python -m pytest backend/tests -q
```

## Input-first flow

Fresh projects are empty: no example house, synthetic findings, or preselected scan. The owner supplies a scan link and any useful materials. A blueprint is optional. Actual Gemini analysis reads attachments, captures scan views, samples approximate depth, derives connected rooms and observed furnishings, then creates meaningful inspection checks, persistent annotations and a draft3D blueprint.

`POST /api/project {}` starts an empty project. Active attachments are cleared; existing private owner files remain saved and are not silently attached to a different house. `PATCH /api/scene {sourceUrl, name?}` resolves a public SuperSplat link or stores a direct public HTTPS splat/progressive URL. Replacing the scene invalidates every previous room, check and finding while keeping current attachments. Repeating the same scene URL is idempotent and preserves audit output. Legacy sample-only bootstrap data migrates once to an empty project while preserving real owner uploads and native source observations. Existing real projects are preserved. An explicit development request `POST /api/inspection {action:"reset",mode:"demo"}` still loads the clearly labeled test workspace; it is not the product default.

Scene metadata resolution reads only the official SuperSplat `/s?id=...` HTML (maximum512 KB,12-second timeout, one same-host redirect). Its `sse-bootstrap` JSON supplies the official published content URL, poster, and optional initial camera. Published hosts are allowlisted. No scene binary, poster, or LOD chunk is fetched, downloaded, mirrored or proxied by the backend. Direct scene links are stored only after scheme, credentials, port, local/private host and DNS checks; DNS resolution never requests the asset itself. Optional local scan upload URLs must belong to this owner.

Materials support PDF, PNG, JPEG, WebP, JSON, text, CSV and Markdown. Uploads are private. `read_materials` reads only files attached to this project: images are sent inline, PDFs use Gemini document understanding, and textual files return bounded original content. Arbitrary PDFs are summarized as their actual content; they are not automatically treated as blueprints. Written design dimensions remain distinct from observed construction.

`create_spatial_model` validates room IDs, adjacency, finite polygons, optional floor elevations/heights, features, observed furniture type/dimensions/rotation, and provenance. Scan-derived models require actual captured evidence plus depth points; the server forces `generatedFrom:"scan"`, `coordinateFrame:"scan"`, `metricStatus:"unmeasured"`, `units:"scene"`, and unknown metric area0. Native coordinates are never labeled meters. Material-derived models use the reference frame with explicitly supplied design dimensions distinguished from unmeasured geometry. Furniture is visual context and does not automatically create a metric compliance check. Unknown furnishings and dimensions must be omitted.

## API

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/api/project` | Empty new project (`{}` or `{action:"reset"}`). |
| GET / POST | `/api/inspection` | Get/start/advance/pause/resume/finalize/reset. |
| PATCH | `/api/scene` | `sourceUrl`, optional `name`, existing `assetUrl`, `scale`, `calibrated`. |
| POST | `/api/uploads` | Multipart `kind` (`blueprint`, `reference`, `scan`) and `file`. |
| GET | `/api/uploads/{id}` | Authenticated owner-scoped streamed retrieval. |
| POST | `/api/blueprint` | Optional explicit structured blueprint import/extraction. |
| POST / PATCH | `/api/findings`, `/api/findings/{id}` | Source/reference marker, owned photo evidence, notes/status history. |
| POST | `/api/agent-tools/{id}` | Complete a pending camera, capture, or geometry request. |
| GET | `/api/report?format=json|html|svg|blueprint|obj` | Canonical report, printable PDF source, map, actual3D model JSON, and OBJ. |
| GET | `/api/health` | Nonsecret runtime/capability readiness. |

Snapshots add `scan.configured`, `posterUrl`, optional `initialCameraPosition` and `initialCameraTarget`. Missing cameras are omitted, not null. `Blueprint.units` is `m|scene`; optional provenance is `generatedFrom`, `coordinateFrame`, and `metricStatus`. Furniture features add `kind:"furniture"`, `objectType`, and rotation in degrees. Source markers before discovery can use `roomId:"unassigned"` with `annotationSource:"scan"`.

JSON/HTML/SVG/3D exports project the same saved revision and finding IDs. Native source pins appear on a map only when coordinate frames match. The OBJ contains actual generated room polygons and observed furniture bounding geometry when dimensions are supplied. Unknown room heights use explicitly labeled0.7-unit schematic cutaway walls; these are not actual wall heights. There is no surveyed-as-built or legal-compliance claim. Empty or unresolved scope remains Incomplete. Cost holdback is unavailable without supplied quotes and contract terms.

## Sketch verification

A materials-derived model (an uploaded sketch read by `POST /api/blueprint`, or a structured JSON plan) is stored as the design reference. Importing it generates one checklist claim per sketched room (`sketch-room-<id>`, category Layout), per drawn connection (`sketch-link-<a>-<b>`), and per drawn feature (`sketch-feature-<id>`, category Presence). When the agent later creates the observed scan-frame model it sets `designRoomId` on each observed room; sketch claims are remapped onto matched rooms, unmatched claims stay `roomId:"unassigned"`, and earlier results carry over by ID. Claims resolve with `basis:"layout"` on captured evidence; written dimensions remain separate metric checks. `GET /api/report?format=json|html` includes a `sketchVerification` table. Sketch and scan frames are never overlaid.

Findings may carry `endAnchor` (dimension line), `region` (3 to 12 point outline), and `imageRegions` (normalized boxes on cited captures). Scan-frame points are kept only when they match returned depth samples. Browser camera poses accumulate in `snapshot.trail` (200 points) so the walk is drawn in the scan view and the blueprint.

## Managed audit and evidence

The server calls Google Interactions with `antigravity-preview-09-2026` and explicit `gemini-4-argon`, background execution, a remote sandbox and a12000-token per-interaction budget. Tools are `read_blueprint` (project manifest), `read_materials`, `create_spatial_model`, `focus_location`, `move_camera` (relative turn/tilt/forward/strafe/rise, executed by the browser from the current pose), `inspect_view`, `sample_geometry`, `add_inspection_item`, `record_result`, and real sandbox `code_execution`. Discovery can start without an existing blueprint. Missing server credentials return a meaningful503 only when actual analysis is requested.

The visible browser completes durable viewer tool requests. Captured images are stored before continuation; checkpoints retain compact results and upload IDs rather than base64. Provider failure/resume does not replay committed findings. Native agent annotations must match returned depth samples. Approximate Gaussian reconstruction/depth can support exploratory code but does not establish validated metric accuracy: numerical geometry, clearance, code and operation verdicts remain blocked until independent evidence exists. Photographic workmanship observations can become review candidates with uncertainty. Owner status edits preserve evidence and cannot silently verify a blocked check.

Default tool-turn budget is512 (configurable16..1024). The real one-hour upper bound remains; there is no minimum delay or fake elapsed time. Budget exhaustion saves an incomplete audit. Pause/resume uses actual active timestamps.

## Configuration and persistence

Server variables: `GEMINI_API_KEY`, `GEMINI_BLUEPRINT_MODEL` (default `gemini-4-argon`), `ARGON_MAX_AGENT_TURNS` (default512), `ARGON_DATA_DIR`, `ARGON_FRONTEND_DIST`, optional `ARGON_API_TOKEN` and `ARGON_OWNER_ID`. Existing `ARGON_*` names remain compatible after the Auditgon rename. Secrets never enter the frontend bundle.

Without a configured deployment token, only actual loopback clients with local hostnames can open private APIs. Run with `--no-proxy-headers`. A configured bearer token is required for every private request, even locally. Untrusted forwarded/identity headers do not select an owner. This configuration represents one owner; multiple users need an authentication adapter. Every checkpoint and file query includes that owner. SQLite WAL plus revision compare-and-swap prevents silent lost updates. The committed migration initializes schema version1 once.

Memory and storage remain bounded:

- Blueprint10 MB, other uploads32 MB;100 files /256 MB per owner.
- Files spool to disk and copy in256 KB chunks. Quota is reserved transactionally.
- At most2 concurrent heavy uploads, extraction or capture operations.
- JSON512 KB; capture bridge2.1 MB; provider response1 MB; captures2 MB base64.
- Material reading: at most3 files /8 MB per tool call, images4 MB each, text64 KB, cached PDF summaries12 KB each (maximum8).
- Depth samples64 per call /128 recent points; events160; paths400; finding history40; findings300; checks600; discovered checks20 per room; executed tool IDs1024.
- Checkpoints1.5 MB; HTTP client4 connections /2 idle keep-alives,45-second provider timeout.

Protocol references: [managed agent](https://ai.google.dev/gemini-api/docs/antigravity-agent), [custom agents](https://ai.google.dev/gemini-api/docs/custom-agents), [structured output](https://ai.google.dev/gemini-api/docs/structured-output), [document understanding](https://ai.google.dev/gemini-api/docs/document-processing).
