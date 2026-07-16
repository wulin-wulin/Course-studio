from fastapi import APIRouter
from pydantic import BaseModel

from ..config import settings, ENV_FILE
from ..services.ai import model_config
from ..services.ai.router import ai_router

router = APIRouter()

ENV_PATH = ENV_FILE


class SettingsResponse(BaseModel):
    gateway_url: str
    gateway_api_key: str
    default_model: str


class SettingsUpdate(BaseModel):
    gateway_url: str | None = None
    gateway_api_key: str | None = None
    default_model: str | None = None


@router.get("/settings", response_model=SettingsResponse)
async def get_settings():
    return _current()


@router.put("/settings", response_model=SettingsResponse)
async def update_settings(body: SettingsUpdate):
    changes: dict[str, str] = {}
    current = _current_values()

    if body.gateway_url is not None:
        api_url = body.gateway_url.strip()
        settings.gateway_url = api_url
        settings.agent_base_url = api_url
        settings.opencode_provider_base_url = api_url
        changes["GATEWAY_URL"] = api_url
        changes["AGENT_BASE_URL"] = api_url
        changes["OPENCODE_PROVIDER_BASE_URL"] = api_url
    else:
        api_url = current["api_url"]

    if body.gateway_api_key is not None and not body.gateway_api_key.startswith("***"):
        api_key = body.gateway_api_key.strip()
        settings.gateway_api_key = api_key
        settings.anthropic_api_key = api_key
        changes["GATEWAY_API_KEY"] = api_key
        changes["ANTHROPIC_API_KEY"] = api_key
    else:
        api_key = current["api_key"]

    if body.default_model is not None:
        default_model = body.default_model.strip()
        settings.default_model = default_model
        settings.gateway_models = default_model
        changes["DEFAULT_MODEL"] = default_model
        changes["GATEWAY_MODELS"] = default_model
    else:
        default_model = current["default_model"]

    if default_model:
        model_config.upsert_model(
            default_model,
            api_url,
            api_key,
            make_default=True,
        )

    if changes:
        _persist_env(changes)
    ai_router.reload()

    return _current()


def _current() -> SettingsResponse:
    current = _current_values()
    return SettingsResponse(
        gateway_url=current["api_url"],
        gateway_api_key=_mask_key(current["api_key"]),
        default_model=current["default_model"],
    )


def _current_values() -> dict[str, str]:
    default_model = model_config.default_model_id()
    model = model_config.get_model(default_model)
    api_url = model.base_url if model and model.base_url else settings.gateway_url
    api_key = model.api_key if model and model.api_key else settings.gateway_api_key

    return {
        "api_url": api_url,
        "api_key": api_key,
        "default_model": default_model,
    }


def _mask_key(key: str) -> str:
    if not key or len(key) <= 8:
        return "***"
    return key[:4] + "***" + key[-4:]


def _persist_env(changes: dict[str, str]) -> None:
    """Write key=value pairs back to .env, updating existing keys in place."""
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    remaining = dict(changes)

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in remaining:
            lines[i] = f"{key}={remaining.pop(key)}"

    for key, value in remaining.items():
        lines.append(f"{key}={value}")

    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
