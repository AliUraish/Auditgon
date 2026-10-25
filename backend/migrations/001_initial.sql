CREATE TABLE IF NOT EXISTS inspections (
    owner_id TEXT PRIMARY KEY,
    inspection_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    document TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS uploads_owner_created_idx ON uploads(owner_id, created_at);
PRAGMA user_version = 1;
