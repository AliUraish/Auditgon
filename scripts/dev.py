#!/usr/bin/env python3
"""Run one Python API and one Vite server; tear down both on Ctrl-C."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "backend" / ".venv" / "bin" / "python"
if not PYTHON.exists():
    sys.exit("Create backend/.venv and install backend/requirements.txt first. See README.md.")
if not (ROOT / "frontend" / "node_modules" / ".bin" / "vite").exists():
    sys.exit("Run npm ci in frontend/ first. See README.md.")

environment = os.environ.copy()
environment.setdefault("NODE_OPTIONS", "--max-old-space-size=1536")
environment.setdefault("PYTHONDONTWRITEBYTECODE", "1")
backend_port = environment.get("ARGON_BACKEND_PORT", "8001")
environment["ARGON_BACKEND_PORT"] = backend_port
processes = []
def stop(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, stop)
try:
    processes.append(subprocess.Popen([
        str(PYTHON), "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
        "--host", "127.0.0.1", "--port", backend_port, "--no-proxy-headers",
        "--workers", "1", "--limit-concurrency", "32", "--timeout-keep-alive", "5",
    ], cwd=ROOT, env=environment, start_new_session=True))
    processes.append(subprocess.Popen(["npm", "run", "dev"], cwd=ROOT / "frontend", env=environment, start_new_session=True))
    print("\nAuditgon dashboard: http://127.0.0.1:3000\nPython API: http://127.0.0.1:{}/api/health\nCtrl-C stops both processes.\n".format(backend_port), flush=True)
    while all(process.poll() is None for process in processes):
        time.sleep(0.5)
    failed = next((process.returncode for process in processes if process.poll() is not None), 1)
    if failed:
        print("An Auditgon server stopped. Shutting down the companion server.", file=sys.stderr)
except KeyboardInterrupt:
    pass
finally:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
