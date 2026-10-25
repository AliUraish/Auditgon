# Auditgon · Spatial audits

Give Auditgon a 3D scan link and any plans, photographs, or documents you have. It opens the scan in the workspace, uses visual tools to examine it, builds a room model and inspection agenda, and keeps the heatmap, spatial markers, and report linked to the same evidence.

```text
Gemini_Argon/
├── frontend/                  React + TypeScript + Vite dashboard and embedded viewer
├── backend/                   Python FastAPI, SQLite, uploads, reports, Gemini integration
├── scripts/dev.py             One API process and one frontend development server
├── Dockerfile                 Builds the frontend and serves everything with Python
└── AUDITGON_INSPECTION_PLAN.md
```

## Run locally

Use Node.js 22.13+ and Python 3.9+.

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.lock.txt
npm --prefix frontend ci
npm run dev
```

Open [the development dashboard](http://127.0.0.1:3000). The API runs on port 8001. Ctrl-C shuts down both processes. The runner uses one Python worker, no Python reloader, and a bounded Node heap.

For the lighter, one-process preview:

```sh
npm run build
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8001 --no-proxy-headers --workers 1 --limit-concurrency 32
```

Open [Auditgon](http://127.0.0.1:8001). Python serves both the built frontend and API. SQLite checkpoints and private uploads persist under `backend/data/`, excluded from source control. `ARGON_DATA_DIR` overrides the storage directory; existing `ARGON_*` environment names remain compatible.

## Workflow

1. Paste a published SuperSplat scene link or supported streamed asset URL in **Scan & materials**. A compact scan file can also be uploaded.
2. Add optional blueprints, photographs, PDFs, structured JSON, or text notes. Files are saved sequentially; photographs are resized before uploading.
3. Choose **Open scan here** to explore, or **Start audit** to run the server-configured Gemini agent. There is no agent-connection step in the product.
4. Review the generated rooms, heatmap, checklist, and findings. Each flag retains its reason, evidence, location, and review history.
5. Explore **3D blueprint** and export the report, drawing, spatial model, or draft 3D geometry.

A scan-only audit can discover visible spaces and workmanship candidates. Supplied blueprints add independent design intent. Generated geometry is a draft: visual reconstruction and rendered depth alone do not establish surveyed dimensions or statutory compliance. Unsupported numeric or operation checks remain unresolved with specific evidence requests. A draft room layout is not represented as a measured as-built drawing. Repair costs and payment holdbacks require supplied quotes and contract terms.

## AI runtime

Set `GEMINI_API_KEY` in the Python server environment and restart it to enable live audits. Credentials stay on the server. The integration uses Google's Managed Agent harness with the `gemini-4-argon` model. Optional `GEMINI_BLUEPRINT_MODEL` selects the extraction model.

The workspace must remain open with its scan loaded for the agent's camera, capture, and approximate depth tools. Provider requests and browser tool responses are checkpointed. A missing key or unavailable evidence produces a visible error or unresolved result; the app does not replace a real audit with sample findings.

## Memory

- One embedded viewer with a 750,000 active splat budget, performance mode, maximum pixel ratio 1.25, disabled post effects, and paused animation.
- Published progressive scans stream directly from their CDN. No remote scene binary is downloaded into this repository or Python service.
- Full remote assets require a known size at most 64 MB; uploaded scan files are limited to 32 MB. Use progressive publishing for larger scans. These limits bound app behavior, but the browser and upstream decoder still control their total memory use.
- Hidden viewers release their graphics context. Offscreen viewers unload after a short grace period, and an explicit **Unload scan** action is always available.
- Captures are compressed JPEGs up to 1280 pixels; depth requests contain at most 64 points. No scan base64 is retained in browser storage.
- Materials upload sequentially to private filesystem storage. Event lists, histories, provider checkpoints, and concurrent heavy operations have fixed limits.
- The 3D blueprint batches lightweight meshes with white edges on a blue architectural grid. It replaces the scan engine while open, so the two renderers never run together in a workspace.

## Checks and packaging

```sh
npm run typecheck
npm test
npm run build
```

The Docker build produces one Python service serving the API and frontend. Mount a persistent volume at `/app/data`. Remote operation requires `ARGON_API_TOKEN` and an authenticated reverse proxy passing the server token. Do not expose a tokenless API. See [the backend documentation](backend/README.md).

The interface draws on [MartinPuli/taste-library](https://github.com/MartinPuli/taste-library). The original test scan is [eraser851's Private Residence Interior](https://superspl.at/scene/9d09ab82).
