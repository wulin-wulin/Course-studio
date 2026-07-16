"""Sanitized model discovery and OpenAI-compatible model registration."""

from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..services.ai import model_config
from ..services.ai.router import ai_router
from ..services.opencode import provision as opencode_provision


router = APIRouter()


class ModelResponse(BaseModel):
    id: str
    name: str
    base_url: str
    has_api_key: bool
    vision: bool
    is_default: bool


class ModelCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: str = Field(min_length=1, max_length=4096)


def _response(model: model_config.ModelDef, default_id: str) -> ModelResponse:
    return ModelResponse(
        id=model.id,
        name=model.name,
        base_url=model.base_url,
        has_api_key=bool(model.api_key),
        vision=model.vision,
        is_default=model.id == default_id,
    )


@router.get("", response_model=list[ModelResponse])
async def list_models():
    default_id = model_config.default_model_id()
    return [_response(model, default_id) for model in model_config.load_models()]


@router.post("", response_model=ModelResponse, status_code=status.HTTP_201_CREATED)
async def create_model(body: ModelCreateRequest):
    name = body.name.strip()
    base_url = body.base_url.strip().rstrip("/")
    api_key = body.api_key.strip()
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Base URL 必须是有效的 HTTP(S) 地址")
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 不能为空")

    try:
        model = model_config.add_model(name, base_url, api_key)
    except ValueError as exc:
        message = str(exc)
        code = status.HTTP_409_CONFLICT if "已存在" in message else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=message) from exc

    # OpenCode watches its generated config in local development. Rewriting it
    # makes a newly registered model available without exposing its key to the
    # browser. A service restart remains a safe fallback for deployments that
    # disable config watching.
    try:
        opencode_provision.write_root_config()
    except OSError:
        pass
    ai_router.reload()
    return _response(model, model_config.default_model_id())
