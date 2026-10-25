"""Bounded upload streaming to private local files, never scan download/proxy."""
from pathlib import Path
from typing import Any, Dict
import os
from fastapi import UploadFile
from .auth import Context
from .config import RESOURCE_LIMITS
from .errors import ApiFailure
from .state import event
from .store import upload_record

ALLOWED = {
    "blueprint": {"application/pdf", "image/png", "image/jpeg", "image/webp", "application/json"},
    "reference": {"image/png", "image/jpeg", "image/webp", "application/pdf", "application/json", "text/plain", "text/markdown", "text/csv"},
    "scan": {"application/octet-stream", "application/ply", "application/x-ply", "application/splat", "application/zip"},
}


def validate_upload(kind: str, content_type: str, size: int) -> int:
    if kind not in ALLOWED:
        raise ApiFailure(400, "Choose blueprint, reference, or scan.", "INVALID_UPLOAD_KIND")
    if content_type not in ALLOWED[kind]:
        raise ApiFailure(415, "Unsupported file type. Blueprints support PDF, PNG, JPEG, WebP, and structured JSON.", "UNSUPPORTED_FILE_TYPE")
    cap = RESOURCE_LIMITS["maxBlueprintBytes"] if kind == "blueprint" else RESOURCE_LIMITS["maxUploadBytes"]
    if not isinstance(size, int) or size < 1 or size > cap:
        raise ApiFailure(413, "The {} must be between 1 byte and {} MB.".format(kind, cap // 1024 // 1024), "UPLOAD_TOO_LARGE")
    return cap


def validate_magic(content_type: str, data: bytes) -> None:
    valid = data.startswith(b"\x89PNG\r\n\x1a\n") if content_type == "image/png" else data.startswith(b"\xff\xd8\xff") if content_type == "image/jpeg" else data.startswith(b"RIFF") and data[8:12] == b"WEBP" if content_type == "image/webp" else data.startswith(b"%PDF-") if content_type == "application/pdf" else True
    if not valid:
        raise ApiFailure(415, "The file contents do not match its declared format.", "INVALID_FILE_CONTENT")


def attach_upload(context: Context, record: Dict[str, Any]) -> None:
    state = context.store.load(context.owner)
    state["snapshot"]["uploads"] = (state["snapshot"]["uploads"] + [upload_record(record)])[-100:]
    event(state, "system", record["kind"].capitalize() + " uploaded", "{} · {:.0f} KB. Stored privately; no extraction has been invented.".format(record["filename"], record["size"] / 1024))
    context.store.save(context.owner, state)


async def save_upload_file(context: Context, kind: str, file: UploadFile):
    content_type = file.content_type or "application/octet-stream"
    expected = file.size if file.size is not None else RESOURCE_LIMITS["maxBlueprintBytes"] if kind == "blueprint" else RESOURCE_LIMITS["maxUploadBytes"]
    cap = validate_upload(kind, content_type, expected)
    record = context.store.reserve_upload(context.owner, kind, file.filename or "upload", content_type, expected)
    destination = context.store.object_path(record)
    temporary = destination.with_suffix(".part")
    size = 0
    try:
        with temporary.open("xb") as output:
            while True:
                chunk = await file.read(256 * 1024)
                if not chunk:
                    break
                if size == 0:
                    validate_magic(content_type, chunk)
                size += len(chunk)
                if size > cap or size > expected:
                    raise ApiFailure(413, "Upload exceeds its bounded file limit.", "UPLOAD_TOO_LARGE")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        validate_upload(kind, content_type, size)
        os.chmod(temporary, 0o600)
        temporary.replace(destination)
        context.store.finish_upload(record, size)
        attach_upload(context, record)
        return upload_record(record)
    except Exception:
        context.store.discard_upload(record)
        raise
    finally:
        await file.close()


def save_bytes(context: Context, kind: str, filename: str, content_type: str, data: bytes):
    validate_upload(kind, content_type, len(data))
    validate_magic(content_type, data)
    record = context.store.reserve_upload(context.owner, kind, filename, content_type, len(data))
    destination = context.store.object_path(record)
    temporary = destination.with_suffix(".part")
    try:
        with temporary.open("xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        temporary.replace(destination)
        context.store.finish_upload(record, len(data))
        return upload_record(record)
    except Exception:
        context.store.discard_upload(record)
        raise


def evidence_for(context: Context, ids):
    records = [context.store.find_upload(context.owner, upload_id) for upload_id in ids]
    if any(record["kind"] != "reference" or not record["content_type"].startswith("image/") for record in records):
        raise ApiFailure(400, "Finding evidence must be an owned reference image upload.", "INVALID_EVIDENCE")
    return [{"id": record["id"], "label": record["filename"], "kind": "image", "imageUrl": "/api/uploads/" + record["id"], "description": "Saved reference image; verify capture context, visibility, and reconstruction limitations."} for record in records]
