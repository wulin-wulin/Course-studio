"""Single source of truth for the selectable models and their endpoints.

Models are declared in ``models.json`` at the project root (gitignored, like
``.env``); each entry carries its own ``base_url`` and ``api_key`` so models can
live on different providers. When the file is absent we fall back to the legacy
``GATEWAY_*`` settings so existing single-provider setups keep working.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from ...config import PROJECT_ROOT, settings

# Per-model keys are deliberately kept outside the package and ignored by Git.
MODELS_FILE = PROJECT_ROOT / "models.json"


@dataclass
class ModelDef:
    id: str
    name: str
    base_url: str
    api_key: str
    vision: bool = True


def _from_file(data: dict) -> list[ModelDef]:
    models: list[ModelDef] = []
    for item in data.get("models", []):
        mid = (item.get("id") or "").strip()
        if not mid:
            continue
        models.append(
            ModelDef(
                id=mid,
                name=item.get("name") or mid,
                base_url=(item.get("base_url") or "").strip(),
                api_key=(item.get("api_key") or "").strip(),
                vision=bool(item.get("vision", True)),
            )
        )
    return models


def _from_env() -> list[ModelDef]:
    ids = [m.strip() for m in settings.gateway_models.split(",") if m.strip()]
    base_url = settings.gateway_url or settings.agent_base_url
    api_key = (
        settings.gateway_api_key
        or settings.openai_api_key
        or settings.anthropic_api_key
    )
    return [
        ModelDef(id=mid, name=mid, base_url=base_url, api_key=api_key, vision=True)
        for mid in ids
    ]


def load_models() -> list[ModelDef]:
    if MODELS_FILE.exists():
        try:
            data = json.loads(MODELS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return _from_env()
        models = _from_file(data)
        if models:
            return models
    return _from_env()


def default_model_id() -> str:
    models = load_models()
    if MODELS_FILE.exists():
        try:
            data = json.loads(MODELS_FILE.read_text(encoding="utf-8"))
            declared = (data.get("default") or "").strip()
            if declared and any(m.id == declared for m in models):
                return declared
        except json.JSONDecodeError:
            pass
    if settings.default_model and any(m.id == settings.default_model for m in models):
        return settings.default_model
    return models[0].id if models else settings.default_model


def get_model(model_id: str) -> ModelDef | None:
    return next((m for m in load_models() if m.id == model_id), None)
