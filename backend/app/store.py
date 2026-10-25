"""Durable, owner-scoped SQLite checkpoints and private file metadata."""
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator
import hashlib
import json
import os
import sqlite3
from .config import BACKEND_ROOT, Settings
from .errors import ApiFailure
from .state import State, initial_state, iso, uid, migrate_legacy_sample


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        settings.uploads_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                connection.executescript((BACKEND_ROOT / "migrations" / "001_initial.sql").read_text())
            elif version != 1:
                raise RuntimeError("Unsupported Auditgon database version")

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(str(self.settings.database_path), timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    def load(self, owner: str) -> State:
        with self.connection() as connection:
            row = connection.execute("SELECT document FROM inspections WHERE owner_id=?", (owner,)).fetchone()
            if row is None:
                state = initial_state()
                connection.execute("INSERT OR IGNORE INTO inspections(owner_id, inspection_id, revision, document, updated_at) VALUES(?,?,?,?,?)",
                                   (owner, state["snapshot"]["id"], 1, json.dumps(state, ensure_ascii=False, allow_nan=False), iso()))
                row = connection.execute("SELECT document FROM inspections WHERE owner_id=?", (owner,)).fetchone()
        state = json.loads(row["document"])
        if migrate_legacy_sample(state):
            self.save(owner, state)
        return state

    def save(self, owner: str, state: State) -> None:
        previous = state["snapshot"]["revision"]
        state["snapshot"].update(revision=previous + 1, updatedAt=iso())
        document = json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(document.encode("utf-8")) > 1_500_000:
            state["snapshot"]["revision"] = previous
            raise ApiFailure(413, "This inspection reached its checkpoint size limit. Export and start a new workspace.", "WORKSPACE_LIMIT")
        with self.connection() as connection:
            changed = connection.execute("UPDATE inspections SET document=?,inspection_id=?,revision=?,updated_at=? WHERE owner_id=? AND revision=?",
                                         (document, state["snapshot"]["id"], previous + 1, state["snapshot"]["updatedAt"], owner, previous)).rowcount
        if not changed:
            state["snapshot"]["revision"] = previous
            raise ApiFailure(409, "The workspace changed in another request. Refresh and try again.", "REVISION_CONFLICT")

    def reserve_upload(self, owner: str, kind: str, filename: str, content_type: str, size: int) -> Dict[str, Any]:
        import re
        upload_id = uid()
        object_key = hashlib.sha256(owner.encode()).hexdigest() + "/" + upload_id
        record = {"id": upload_id, "owner_id": owner, "object_key": object_key, "kind": kind,
                  "filename": re.sub(r"[^a-zA-Z0-9_.() -]", "_", filename)[:160] or "upload", "content_type": content_type, "size": size, "created_at": iso(), "ready": 0}
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                quota = connection.execute("SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM uploads WHERE owner_id=?", (owner,)).fetchone()
                if quota["count"] >= 100 or quota["bytes"] + size > 256 * 1024 * 1024:
                    raise ApiFailure(413, "This workspace reached its 100-file / 256 MB storage limit.", "STORAGE_LIMIT")
                connection.execute("INSERT INTO uploads(id,owner_id,object_key,kind,filename,content_type,size,created_at,ready) VALUES(:id,:owner_id,:object_key,:kind,:filename,:content_type,:size,:created_at,:ready)", record)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return record

    def finish_upload(self, record: Dict[str, Any], size: int) -> None:
        with self.connection() as connection:
            connection.execute("UPDATE uploads SET size=?,ready=1 WHERE id=? AND owner_id=?", (size, record["id"], record["owner_id"]))
        record.update(size=size, ready=1)

    def discard_upload(self, record: Dict[str, Any]) -> None:
        with self.connection() as connection:
            connection.execute("DELETE FROM uploads WHERE id=? AND owner_id=?", (record["id"], record["owner_id"]))
        self.object_path(record).unlink(missing_ok=True)
        self.object_path(record).with_suffix(".part").unlink(missing_ok=True)

    def find_upload(self, owner: str, upload_id: str) -> Dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM uploads WHERE id=? AND owner_id=? AND ready=1", (upload_id, owner)).fetchone()
        if row is None:
            raise ApiFailure(404, "Upload not found in this workspace.", "NOT_FOUND")
        return dict(row)

    def object_path(self, record: Dict[str, Any]) -> Path:
        # Keys are server-generated hashes/UUIDs; filenames never enter disk paths.
        path = self.settings.uploads_dir / record["object_key"]
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path


def upload_record(record: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": record["id"], "kind": record["kind"], "filename": record["filename"], "contentType": record["content_type"], "size": record["size"], "url": "/api/uploads/" + record["id"], "createdAt": record["created_at"]}
