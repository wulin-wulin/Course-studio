from urllib.parse import urlparse
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, SecretStr

from ..config import settings, ENV_FILE
from ..services.ai import model_config
from ..services.ai.router import ai_router

router = APIRouter()

ENV_PATH = ENV_FILE
MINERU_DEFAULT_API_BASE = "https://mineru.net/api/v4"


class SettingsResponse(BaseModel):
    gateway_url: str
    gateway_api_key: str
    default_model: str


class SettingsUpdate(BaseModel):
    gateway_url: str | None = None
    gateway_api_key: str | None = None
    default_model: str | None = None


class MinerUSettingsResponse(BaseModel):
    """Safe, browser-facing MinerU configuration status.

    The token field is always masked.  ``mineru_token_configured`` is provided
    separately so the UI can distinguish an empty configuration from a short
    token whose masked representation is also ``***``.
    """

    document_parser: Literal["local", "mineru", "auto"]
    mineru_api_base: str
    mineru_api_token: str
    mineru_token_configured: bool
    mineru_timeout_seconds: float
    mineru_model_version: Literal["vlm", "pipeline"]


class MinerUSettingsUpdate(BaseModel):
    document_parser: Literal["local", "mineru", "auto"] | None = None
    # Length checks are performed in the handler instead of Pydantic Field
    # constraints so validation errors never echo a submitted secret in their
    # ``input`` payload.
    mineru_api_base: str | None = None
    # SecretStr keeps Pydantic validation errors from echoing a submitted key
    # when another field in the same request is invalid.
    mineru_api_token: SecretStr | None = None
    mineru_timeout_seconds: float | None = Field(default=None, ge=1, le=3600)
    mineru_model_version: Literal["vlm", "pipeline"] | None = None


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


@router.get("/settings/mineru", response_model=MinerUSettingsResponse)
async def get_mineru_settings():
    """Return the effective MinerU settings without exposing its token."""
    return _current_mineru()


@router.put("/settings/mineru", response_model=MinerUSettingsResponse)
async def update_mineru_settings(body: MinerUSettingsUpdate):
    """Update MinerU settings for the local backend and persist them to .env.

    A blank or masked token means "keep the current token".  This lets the
    browser submit the form after loading a masked value without ever reading
    the secret back from the server.
    """
    changes: dict[str, str] = {}
    next_api_base = settings.mineru_api_base
    next_token = settings.mineru_api_token
    next_timeout = float(settings.mineru_timeout_seconds)
    next_model_version = settings.mineru_model_version
    next_document_parser = settings.document_parser

    if body.mineru_api_base is not None:
        _ensure_env_value(body.mineru_api_base, "MinerU API Base")
        api_base = body.mineru_api_base.strip().rstrip("/")
        if len(api_base) > 2048:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MinerU API Base is too long",
            )
        parsed = urlparse(api_base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MinerU API Base must be a valid HTTP(S) URL",
            )
        _ensure_env_value(api_base, "MinerU API Base")
        next_api_base = api_base
        changes["MINERU_API_BASE"] = api_base

    if body.mineru_api_token is not None:
        token = body.mineru_api_token.get_secret_value().strip()
        _ensure_env_value(token, "MinerU API Token")
        # The GET response is intentionally masked.  Empty/masked submissions
        # preserve the existing secret and therefore cannot accidentally erase
        # a working configuration.
        if token and not token.startswith("***"):
            if len(token) > 4096:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="MinerU API Token is too long",
                )
            _ensure_env_value(token, "MinerU API Token")
            next_token = token
            changes["MINERU_API_TOKEN"] = token

    if body.mineru_timeout_seconds is not None:
        timeout = float(body.mineru_timeout_seconds)
        next_timeout = timeout
        changes["MINERU_TIMEOUT_SECONDS"] = _format_float(timeout)

    if body.mineru_model_version is not None:
        next_model_version = body.mineru_model_version
        changes["MINERU_MODEL_VERSION"] = body.mineru_model_version

    if body.document_parser is not None:
        next_document_parser = body.document_parser
        changes["DOCUMENT_PARSER"] = body.document_parser

    if changes:
        try:
            _persist_env(changes)
        except OSError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Backend configuration file is not writable; check the .env mount permissions",
            ) from exc
        settings.mineru_api_base = next_api_base
        settings.mineru_api_token = next_token
        settings.mineru_timeout_seconds = next_timeout
        settings.mineru_model_version = next_model_version
        settings.document_parser = next_document_parser
    return _current_mineru()


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


def _current_mineru() -> MinerUSettingsResponse:
    token = settings.mineru_api_token.strip()
    return MinerUSettingsResponse(
        document_parser=settings.document_parser,
        mineru_api_base=(settings.mineru_api_base or MINERU_DEFAULT_API_BASE).rstrip("/"),
        mineru_api_token=_mask_key(token),
        mineru_token_configured=bool(token),
        mineru_timeout_seconds=float(settings.mineru_timeout_seconds),
        mineru_model_version=settings.mineru_model_version,
    )


def _mask_key(key: str) -> str:
    if not key or len(key) <= 8:
        return "***"
    return key[:4] + "***" + key[-4:]


def _ensure_env_value(value: str, label: str) -> None:
    if "\r" in value or "\n" in value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{label} must not contain newline characters",
        )


def _format_float(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


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
