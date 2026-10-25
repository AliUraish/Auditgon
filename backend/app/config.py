"""Runtime configuration; no credentials are sent to the browser."""
from dataclasses import dataclass, field
from pathlib import Path
import os

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RESOURCE_LIMITS = {
    "maxUploadBytes": 32 * 1024 * 1024,
    "maxBlueprintBytes": 10 * 1024 * 1024,
    "maxSceneBytes": 64 * 1024 * 1024,
    "maxSplats": 750_000,
    "maxEvents": 160,
    "maxPixelRatio": 1.25,
    "maxImageEdge": 1280,
}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("ARGON_DATA_DIR", str(BACKEND_ROOT / "data"))))
    frontend_dist: Path = field(default_factory=lambda: Path(os.environ.get("ARGON_FRONTEND_DIST", str(BACKEND_ROOT.parent / "frontend" / "dist"))))
    api_token: str = field(default_factory=lambda: os.environ.get("ARGON_API_TOKEN", ""))
    owner_id: str = field(default_factory=lambda: os.environ.get("ARGON_OWNER_ID", "local-owner"))
    gemini_key: str = field(default_factory=lambda: os.environ.get("GEMINI_API_KEY", ""))
    blueprint_model: str = field(default_factory=lambda: os.environ.get("GEMINI_BLUEPRINT_MODEL", "gemini-4-argon"))
    max_agent_turns: int = field(default_factory=lambda: min(1024, max(16, int(os.environ.get("ARGON_MAX_AGENT_TURNS", "512")))))
    allow_local: bool = True

    @property
    def database_path(self) -> Path:
        return self.data_dir / "argon.db"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"
