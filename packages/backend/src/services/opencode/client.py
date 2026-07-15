"""Thin async client for the opencode HTTP server (https://opencode.ai/docs/server).

We talk to a locally running ``opencode serve`` over HTTP + SSE rather than
depending on a third-party SDK, to keep dependencies under control.
"""

import json
from collections.abc import AsyncIterator

import httpx

from ...config import settings
from ..ai import model_config


class OpencodeError(RuntimeError):
    pass


def _base_url() -> str:
    return settings.opencode_base_url.rstrip("/")


def _auth() -> tuple[str, str] | None:
    if not settings.opencode_server_password:
        return None
    return ("opencode", settings.opencode_server_password)


async def health() -> dict:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{_base_url()}/global/health", auth=_auth())
        resp.raise_for_status()
        return resp.json()


async def create_session(directory: str, title: str | None = None) -> str:
    body: dict = {}
    if title:
        body["title"] = title
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{_base_url()}/session",
            params={"directory": directory},
            json=body,
            auth=_auth(),
        )
        resp.raise_for_status()
        data = resp.json()
    session_id = data.get("id")
    if not session_id:
        raise OpencodeError(f"opencode 未返回 session id：{data}")
    return session_id


async def prompt(
    session_id: str,
    parts: list[dict],
    directory: str,
    model_id: str | None = None,
) -> None:
    """Send a prompt without waiting for completion; result arrives via /event.

    Each model is registered as its own opencode provider whose id equals the
    model id (see scripts/gen_opencode_config.py), so providerID == modelID.
    """
    mid = model_id or model_config.default_model_id()
    body = {
        "model": {
            "providerID": mid,
            "modelID": mid,
        },
        "parts": parts,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{_base_url()}/session/{session_id}/prompt_async",
            params={"directory": directory},
            json=body,
            auth=_auth(),
        )
        if resp.status_code not in (200, 204):
            raise OpencodeError(
                f"opencode prompt 失败：{resp.status_code} {resp.text[:300]}"
            )


async def abort(session_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{_base_url()}/session/{session_id}/abort", auth=_auth())
    except Exception:
        pass


async def events() -> AsyncIterator[dict]:
    """Yield parsed SSE events from the global event stream.

    opencode 1.17.7 emits business events only on ``/global/event`` (the plain
    ``/event`` stream carries heartbeats only). Each event is wrapped in an
    envelope ``{"directory", "project", "payload": {"type", "properties"}}`` —
    we yield the whole envelope so the caller can read ``payload.type`` /
    ``payload.properties`` and filter by ``directory``/``sessionID``.
    """
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("GET", f"{_base_url()}/global/event", auth=_auth()) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                raw = line[len("data:") :].strip()
                if not raw:
                    continue
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError:
                    continue
