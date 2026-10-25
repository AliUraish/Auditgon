# Auditgon frontend

React, TypeScript, Vite, and the official embedded SuperSplat viewer. The Python backend lives in the sibling `backend/` directory.

Run `npm ci` here, then `npm run dev` with the backend at `127.0.0.1:8001`. Vite proxies `/api` to Python. `npm run build` creates the static `dist/` that Python serves directly.

The dark dashboard starts with a scan link and optional project materials. A configured scan streams from its remote source when opened. A single viewer uses a 750k active splat budget, unloads when hidden, and supports native source-coordinate finding markers. The generated 3D blueprint uses lightweight vector geometry instead of another scan engine.

Model provenance and measurement status accompany generated rooms. The finding markers, review history, and report share persisted records.

The design draws on the [Taste Library](https://github.com/MartinPuli/taste-library); see `components/argon/DESIGN.md` for the selected references. The internal component-directory name remains compatible with existing imports.
