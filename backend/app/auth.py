"""Loopback owner by default; optional server-configured deployment bearer token."""
from dataclasses import dataclass
import ipaddress
import secrets
from fastapi import Request
from .config import Settings
from .errors import ApiFailure
from .store import Store


@dataclass
class Context:
    owner: str
    store: Store
    settings: Settings


def context_for(request: Request) -> Context:
    settings = request.app.state.settings
    authorization = request.headers.get("authorization", "")
    token = authorization[7:] if authorization.lower().startswith("bearer ") else ""
    if settings.api_token:
        # A configured deployment token is always required, including loopback.
        if not token or not secrets.compare_digest(token, settings.api_token):
            raise ApiFailure(401, "Provide the configured bearer token to open this private inspection workspace.", "AUTH_REQUIRED")
    else:
        try:
            loopback = ipaddress.ip_address(request.client.host).is_loopback if request.client else False
        except ValueError:
            loopback = request.client.host == "localhost" if request.client else False
        hostname = request.url.hostname or ""
        if not settings.allow_local or not loopback or hostname not in ("localhost", "127.0.0.1", "::1", "testserver"):
            raise ApiFailure(401, "Local owner access is loopback-only. Configure ARGON_API_TOKEN before exposing this backend.", "AUTH_REQUIRED")
    return Context(settings.owner_id, request.app.state.store, settings)


def capabilities(context: Context):
    return {"managedAgent": bool(context.settings.gemini_key), "uploads": True, "persistence": True,
            "providerMessage": "Gemini key configured. Managed Agents use gemini-4-argon; model access is verified on the first real call. Visual tools require this dashboard and its loaded scan." if context.settings.gemini_key else "Add GEMINI_API_KEY to the Python server environment to enable gemini-4-argon Managed Agents and blueprint extraction. Demo data is synthetic."}


def public_snapshot(context: Context, state):
    from .state import elapsed_seconds
    return {**state["snapshot"], "elapsedSeconds": elapsed_seconds(state), "capabilities": capabilities(context)}
