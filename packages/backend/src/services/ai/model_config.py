"""Single source of truth for the selectable models and their endpoints.

Models are declared in ``models.json`` at the project root (gitignored, like
``.env``); each entry carries its own ``base_url`` and ``api_key`` so models can
live on different providers. When the file is absent we fall back to the legacy
``GATEWAY_*`` settings so existing single-provider setups keep working.

An entry may also declare ``limit`` in OpenCode's own shape,
``{"context": <tokens>, "output": <tokens>}``. Custom OpenAI-compatible
providers carry no token metadata, so this is how OpenCode learns the window
it needs for automatic compaction. ``scripts/gen_opencode_config.py`` parses
the same field with identical rules.
"""

import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from ...config import PROJECT_ROOT, settings

# Per-model keys are deliberately kept outside the package and ignored by Git.
MODELS_FILE = PROJECT_ROOT / "models.json"
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MODELS_LOCK = threading.RLock()
_LIMIT_KEYS = ("context", "output")


@dataclass
class ModelDef:
    id: str
    name: str
    base_url: str
    api_key: str
    vision: bool = True
    # Declared OpenCode token budget; ``None`` when absent or malformed.
    limit: dict[str, int] | None = None


def _parse_limit(value: object) -> dict[str, int] | None:
    """Validate an optional ``limit`` declaration from ``models.json``.

    Returns ``None`` when nothing is declared and raises ``ValueError`` with a
    readable reason when the declaration cannot be forwarded to OpenCode.
    """

    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("limit 必须是包含 context 与 output 的对象")
    unknown = sorted(str(key) for key in value if key not in _LIMIT_KEYS)
    if unknown:
        raise ValueError(f"limit 只支持 context 与 output，不支持：{', '.join(unknown)}")
    limit: dict[str, int] = {}
    for key in _LIMIT_KEYS:
        number = value.get(key)
        # JSON true is a Python int; it must not become a one-token window.
        if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
            raise ValueError(f"limit.{key} 必须是正整数")
        limit[key] = number
    # OpenCode compacts against ``context - output``; a non-positive budget
    # would make every turn overflow.
    if limit["output"] >= limit["context"]:
        raise ValueError("limit.output 必须小于 limit.context")
    return limit


def _model_def(item: dict) -> ModelDef:
    mid = (item.get("id") or "").strip()
    try:
        limit = _parse_limit(item.get("limit"))
    except ValueError:
        # A malformed optional budget must not hide the model itself. The
        # OpenCode launcher reports the reason when it generates its config.
        limit = None
    return ModelDef(
        id=mid,
        name=item.get("name") or mid,
        base_url=(item.get("base_url") or "").strip(),
        api_key=(item.get("api_key") or "").strip(),
        vision=bool(item.get("vision", True)),
        limit=limit,
    )


def _from_file(data: dict) -> list[ModelDef]:
    models: list[ModelDef] = []
    for item in data.get("models", []):
        model = _model_def(item)
        if model.id:
            models.append(model)
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


def _read_document() -> dict:
    if MODELS_FILE.exists():
        try:
            value = json.loads(MODELS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("models.json 不是有效的 JSON") from exc
        if not isinstance(value, dict) or not isinstance(value.get("models", []), list):
            raise ValueError("models.json 数据结构无效")
        return value

    models = _from_env()
    return {
        "default": default_model_id(),
        "models": [
            {
                "id": model.id,
                "name": model.name,
                "base_url": model.base_url,
                "api_key": model.api_key,
                "vision": model.vision,
            }
            for model in models
        ],
    }


def _write_document(data: dict) -> None:
    MODELS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = MODELS_FILE.with_suffix(MODELS_FILE.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, MODELS_FILE)


def _model_item(model_id: str, name: str, base_url: str, api_key: str) -> dict:
    if not _MODEL_ID_RE.fullmatch(model_id):
        raise ValueError("模型名称只能包含字母、数字、点、下划线和连字符")
    return {
        "id": model_id,
        "name": name or model_id,
        "base_url": base_url.strip(),
        "api_key": api_key.strip(),
        "vision": True,
    }


def add_model(name: str, base_url: str, api_key: str) -> ModelDef:
    """Append one OpenAI-compatible model without exposing or replacing keys."""

    model_id = name.strip()
    item = _model_item(model_id, model_id, base_url, api_key)
    with _MODELS_LOCK:
        data = _read_document()
        models = data.setdefault("models", [])
        if any(isinstance(model, dict) and model.get("id") == model_id for model in models):
            raise ValueError(f"模型已存在：{model_id}")
        models.append(item)
        if not data.get("default"):
            data["default"] = model_id
        _write_document(data)
    return _model_def(item)


def upsert_model(
    model_id: str,
    base_url: str,
    api_key: str,
    *,
    make_default: bool = False,
) -> ModelDef:
    """Update a legacy settings model while preserving every other model."""

    normalized_id = model_id.strip()
    item = _model_item(normalized_id, normalized_id, base_url, api_key)
    with _MODELS_LOCK:
        data = _read_document()
        models = data.setdefault("models", [])
        for index, current in enumerate(models):
            if isinstance(current, dict) and current.get("id") == normalized_id:
                # The settings form only owns the endpoint. Keep hand-edited
                # fields such as ``name``, ``vision`` and ``limit``.
                item = {
                    **current,
                    "base_url": item["base_url"],
                    "api_key": item["api_key"],
                }
                models[index] = item
                break
        else:
            models.append(item)
        if make_default or not data.get("default"):
            data["default"] = normalized_id
        _write_document(data)
    return _model_def(item)
