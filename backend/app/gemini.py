"""Current Google Interactions REST protocol with bounded streamed responses."""
from typing import Any, Dict, Optional
import json
import httpx
from .errors import ApiFailure

INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"


class GeminiClient:
    def __init__(self, api_key: str, client: httpx.AsyncClient):
        self.api_key = api_key
        self.client = client

    async def request(self, path: str = "", body: Optional[Dict[str, Any]] = None, method: Optional[str] = None) -> Dict[str, Any]:
        if not self.api_key:
            raise ApiFailure(503, "Add GEMINI_API_KEY to the Python server environment to enable Gemini. The sample workspace remains available.", "GEMINI_NOT_CONFIGURED")
        # Every provider URL is this fixed origin; no user-supplied URL is fetched.
        url = INTERACTIONS_URL + path
        try:
            async with self.client.stream(method or ("GET" if body is None else "POST"), url,
                                          headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json", "Api-Revision": "2026-05-20"},
                                          json=body, timeout=httpx.Timeout(45, connect=10)) as response:
                if response.status_code >= 400:
                    message = "The Gemini key does not have access to this agent or model. Verify gemini-4-argon access in Google AI Studio." if response.status_code in (401, 403) else "Gemini quota or rate limit reached. Wait before resuming the saved inspection." if response.status_code == 429 else "Gemini rejected the request. Check access to the current Interactions API and gemini-4-argon." if response.status_code == 400 else "Gemini could not finish this request. The saved checkpoint is preserved."
                    raise ApiFailure(429 if response.status_code == 429 else 502, message, "PROVIDER_" + str(response.status_code))
                contents = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(contents) + len(chunk) > 1024 * 1024:
                        raise ApiFailure(502, "The Gemini response exceeded the bounded checkpoint limit.", "PROVIDER_RESPONSE_LIMIT")
                    contents.extend(chunk)
        except httpx.HTTPError:
            raise ApiFailure(502, "Gemini did not respond in time. The saved checkpoint is intact.", "PROVIDER_UNREACHABLE") from None
        try:
            data = json.loads(contents)
        except (ValueError, UnicodeDecodeError):
            raise ApiFailure(502, "Gemini returned invalid JSON.", "PROVIDER_INVALID_RESPONSE") from None
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not isinstance(data.get("status"), str):
            raise ApiFailure(502, "Gemini did not return an interaction checkpoint.", "PROVIDER_INVALID_RESPONSE")
        return data


def interaction_text(interaction: Dict[str, Any]) -> str:
    if isinstance(interaction.get("output_text"), str):
        return interaction["output_text"][:200_000]
    texts = []
    for step in interaction.get("steps", []) + interaction.get("outputs", []):
        if step.get("type") in ("text", "model_output") and isinstance(step.get("text"), str):
            texts.append(step["text"])
        if step.get("type") == "model_output" and isinstance(step.get("content"), list):
            texts.extend(content["text"] for content in step["content"] if isinstance(content, dict) and isinstance(content.get("text"), str))
    return "\n".join(texts)[:200_000]


def parse_provider_json(text: str) -> Any:
    import re
    value = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.I)
    value = re.sub(r"\s*```$", "", value)
    try:
        return json.loads(value)
    except ValueError:
        raise ApiFailure(502, "Gemini did not produce a valid structured blueprint. No extracted dimensions were saved.", "INVALID_EXTRACTION") from None
