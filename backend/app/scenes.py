"""Resolve public scene metadata only. Never fetch or proxy a scan binary."""
from html.parser import HTMLParser
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
import json
import math
import re
import asyncio
import ipaddress
import socket
import httpx
from .errors import ApiFailure
from .models import safe_asset_url

SUPER_HOSTS = {"superspl.at", "www.superspl.at"}
PUBLISHED_HOSTS = {"d28zzqy0iyovbz.cloudfront.net", "supersplat-content.playcanvas.com", "content.superspl.at"}
POSTER_HOSTS = PUBLISHED_HOSTS | {"s3-eu-west-1.amazonaws.com", "images.playcanvas.com", "superspl.at"}
SCENE_EXTENSIONS = (".sog", ".ply", "/lod-meta.json")


def supported_scene_filename(filename: str) -> bool:
    lower = filename.lower()
    return lower.endswith((".sog", ".ply")) or lower == "lod-meta.json"


class BootstrapParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capture = False
        self.chunks = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "script" and attrs.get("id") == "sse-bootstrap" and attrs.get("type") == "application/json":
            self.capture = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.capture = False

    def handle_data(self, data):
        if self.capture:
            self.chunks.append(data)


def scene_id(url: str) -> Optional[str]:
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in SUPER_HOSTS:
        return None
    match = re.fullmatch(r"/scene/([a-zA-Z0-9_-]{6,40})/?", parsed.path)
    if match:
        return match.group(1)
    candidate = parse_qs(parsed.query).get("id", [""])[0] if parsed.path in ("/s", "/s/") else ""
    return candidate if re.fullmatch(r"[a-zA-Z0-9_-]{6,40}", candidate) else None


def vector(value):
    if not isinstance(value, list) or len(value) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 10000 for v in value):
        return None
    return value


async def metadata_html(client: httpx.AsyncClient, url: str) -> str:
    current = url
    for redirect in range(2):
        parsed = urlparse(current)
        if parsed.scheme != "https" or parsed.hostname not in SUPER_HOSTS or parsed.port not in (None, 443):
            raise ApiFailure(400, "Scene metadata redirects must stay on the official SuperSplat host.", "UNSAFE_SCENE_REDIRECT")
        try:
            async with client.stream("GET", current, timeout=httpx.Timeout(12, connect=5), follow_redirects=False, headers={"Accept": "text/html"}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    if redirect or not response.headers.get("location"):
                        raise ApiFailure(502, "The scene metadata redirected too many times.", "SCENE_METADATA_UNAVAILABLE")
                    current = urljoin(current, response.headers["location"])
                    continue
                if response.status_code != 200:
                    raise ApiFailure(400, "This public SuperSplat scene could not be opened. Check its link and sharing settings.", "SCENE_METADATA_UNAVAILABLE")
                if "text/html" not in response.headers.get("content-type", "").lower():
                    raise ApiFailure(502, "SuperSplat metadata was not an HTML page.", "INVALID_SCENE_METADATA")
                try:
                    size = int(response.headers.get("content-length", "0"))
                except ValueError:
                    size = 0
                if size > 512 * 1024:
                    raise ApiFailure(502, "Scene metadata exceeds the safe HTML size limit.", "SCENE_METADATA_LIMIT")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > 512 * 1024:
                        raise ApiFailure(502, "Scene metadata exceeds the safe HTML size limit.", "SCENE_METADATA_LIMIT")
                    data.extend(chunk)
                return data.decode("utf-8", errors="replace")
        except httpx.HTTPError:
            raise ApiFailure(502, "The public scene metadata did not respond in time. The scan binary was not fetched.", "SCENE_METADATA_UNAVAILABLE") from None
    raise ApiFailure(502, "Scene metadata unavailable.", "SCENE_METADATA_UNAVAILABLE")


def parse_bootstrap(html: str, identifier: str) -> Dict[str, Any]:
    parser = BootstrapParser()
    parser.feed(html)
    try:
        data = json.loads("".join(parser.chunks))
    except ValueError:
        raise ApiFailure(502, "This scene does not expose supported published viewer metadata.", "INVALID_SCENE_METADATA") from None
    content = safe_asset_url(data.get("contentUrl")) if isinstance(data, dict) and isinstance(data.get("contentUrl"), str) else None
    parsed = urlparse(content or "")
    if not content or parsed.hostname not in PUBLISHED_HOSTS or not parsed.path.lower().endswith(SCENE_EXTENSIONS):
        raise ApiFailure(502, "Published scene content is not on a supported official host.", "INVALID_SCENE_CONTENT")
    if identifier not in parsed.path.split("/"):
        raise ApiFailure(502, "Published content does not match the requested scene ID.", "INVALID_SCENE_CONTENT")
    poster = None
    if isinstance(data.get("posterUrl"), str):
        candidate = safe_asset_url(data["posterUrl"])
        if urlparse(candidate or "").hostname in POSTER_HOSTS:
            poster = candidate
    result = {"sourceUrl": "https://superspl.at/scene/" + identifier, "assetUrl": content, "posterUrl": poster, "configured": True, "name": "SuperSplat scene " + identifier}
    settings = data.get("settings", {})
    cameras = settings.get("cameras", []) if isinstance(settings, dict) else []
    initial = cameras[0].get("initial", {}) if cameras and isinstance(cameras[0], dict) else {}
    position, target = vector(initial.get("position")), vector(initial.get("target"))
    if position is not None and target is not None:
        result.update(initialCameraPosition=position, initialCameraTarget=target)
    return result


async def resolve_scene(client: httpx.AsyncClient, url: str) -> Dict[str, Any]:
    candidate = safe_asset_url(url)
    if not candidate or candidate.startswith("/"):
        raise ApiFailure(400, "Supply a public HTTPS scene link.", "INVALID_SCENE_URL")
    parsed = urlparse(candidate)
    if parsed.hostname in SUPER_HOSTS:
        identifier = scene_id(candidate)
        if not identifier:
            raise ApiFailure(400, "Use a published SuperSplat /scene/<id> link.", "INVALID_SCENE_URL")
        page = await metadata_html(client, "https://superspl.at/s?" + urlencode({"id": identifier}))
        return parse_bootstrap(page, identifier)
    if not parsed.path.lower().endswith(SCENE_EXTENSIONS):
        raise ApiFailure(400, "Use a SuperSplat scene link, direct HTTPS .sog or .ply, or progressive lod-meta.json URL.", "UNSUPPORTED_SCENE_URL")
    await verify_public_host(parsed.hostname)
    # Direct scene links are validated and stored only; no HEAD/GET follows them.
    return {"sourceUrl": candidate, "assetUrl": candidate, "posterUrl": None, "configured": True, "name": parsed.path.rstrip("/").rsplit("/", 1)[-1] or "Uploaded scan"}


async def verify_public_host(hostname: str) -> None:
    """Resolve DNS only; direct scene bytes are never requested by this server."""
    try:
        records = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(hostname, 443, type=socket.SOCK_STREAM), timeout=3)
    except (OSError, asyncio.TimeoutError):
        raise ApiFailure(400, "The direct scene hostname could not be verified as public. Use a published SuperSplat link.", "UNVERIFIED_SCENE_HOST") from None
    addresses = {record[4][0] for record in records}
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ApiFailure(400, "Direct scan links cannot resolve to local or private network addresses.", "PRIVATE_SCENE_URL")
