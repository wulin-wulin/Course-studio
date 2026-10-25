#!/usr/bin/env python3
"""Generate the restricted OpenCode config for course-data agents.

Each model becomes its own opencode provider (providerID == modelID == the
model id) so models with different endpoints/keys all work. Run by
scripts/opencode.sh before launching the server.

The OpenCode server runs in a per-conversation course workspace.  It may read
the workspace, but it may only mutate course package JSON files.  Keeping this
policy here (rather than relying on a model prompt) makes the later course
management skills safe to add without granting access to application code.

Usage: gen_opencode_config.py <output_path>
Reads models.json from the project root; falls back to env vars when absent.
"""

from __future__ import annotations

from copy import deepcopy
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS_FILE = ROOT / "models.json"

MODEL_CAPS = {
    "attachment": True,
    "tool_call": True,
    "modalities": {"input": ["text", "image"], "output": ["text"]},
}

# OpenCode cannot infer token limits for our custom OpenAI-compatible
# providers. Without an explicit limit it reports ``context: 0`` and cannot
# calculate a safe automatic-compaction threshold.
KIMI_256K_MODEL_IDS = frozenset({
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2-0905-preview",
    "kimi-k2-turbo-preview",
})
KIMI_256K_LIMIT = {"context": 262_144, "output": 32_768}
COMPACTION = {
    "auto": True,
    "keep": {"tokens": 15_000},
    "buffer": 20_000,
    # OpenCode 1.18.x uses this deprecated name for ``buffer``. Keeping the
    # values equal makes the config effective before and after an upgrade.
    "reserved": 20_000,
}


def _model_caps(model_id: str) -> dict:
    capabilities = dict(MODEL_CAPS)
    if model_id in KIMI_256K_MODEL_IDS:
        capabilities["limit"] = dict(KIMI_256K_LIMIT)
    return capabilities


PERMISSION = {
    # A session workspace contains a copy of one or more course packages.
    # Keep the allow-list narrow enough that AGENTS.md, OpenCode config and
    # every application source file remain immutable to the agent.
    "edit": {
        "**": "deny",
        "**/course.json": "allow",
        "**/index.json": "allow",
        "**/points/*.json": "allow",
    },
    # Course-management skills will be added incrementally.  They inherit the
    # JSON-only file policy above, so allowing registered skills here does not
    # expand filesystem authority.
    "skill": {"*": "allow"},
    "question": "deny",
    "bash": "deny",
    "course_pipeline": "deny",
    "webfetch": "deny",
    # Never leave a headless Agent session waiting on an OpenCode permission
    # prompt that the Course Studio UI cannot answer.
    "doom_loop": "deny",
}

COURSE_OUTLINE_CREATOR_PERMISSION = {
    "edit": {
        "**": "deny",
        "**/pipeline/*/course-content/src/data/course.json": "allow",
        "**/pipeline/*/course-content/src/data/index.json": "allow",
        "**/pipeline/*/course-content/generation/manifest.json": "allow",
        "**/pipeline/*/textbook-outline.json": "allow",
    },
    "skill": {
        "*": "deny",
        "candidate-knowledge-point-generator": "allow",
        "textbook-outline-generator": "allow",
        "knowledge-pipeline-orchestrator": "allow",
    },
    "task": "deny",
    "question": "allow",
    "bash": "deny",
    "course_pipeline": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "doom_loop": "deny",
}

COURSE_CREATOR_PERMISSION = {
    "edit": {
        "**": "deny",
        "**/pipeline/*/course-content/src/data/course.json": "allow",
        "**/pipeline/*/course-content/src/data/index.json": "allow",
        "**/pipeline/*/course-content/generation/manifest.json": "allow",
        "**/pipeline/*/course-content/generation/animation-manifest.json": "allow",
        "**/pipeline/*/clustered-graph.json": "allow",
        "**/pipeline/*/textbook-outline.json": "allow",
    },
    "skill": {
        "*": "deny",
        "candidate-knowledge-point-generator": "allow",
        "knowledge-cluster-builder": "allow",
        "knowledge-pipeline-orchestrator": "allow",
        "textbook-outline-generator": "allow",
    },
    "task": {
        "*": "deny",
        "course-content-worker": "allow",
        "course-animation-worker": "allow",
    },
    "question": "allow",
    "bash": "deny",
    "course_pipeline": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "doom_loop": "deny",
}


def _without_manifest_edit(permission: dict) -> dict:
    """Keep textbook agents from replacing the trusted manifest scaffold."""

    restricted = deepcopy(permission)
    restricted["edit"].pop(
        "**/pipeline/*/course-content/generation/manifest.json",
        None,
    )
    return restricted


TEXTBOOK_OUTLINE_CREATOR_PERMISSION = _without_manifest_edit(
    COURSE_OUTLINE_CREATOR_PERMISSION
)
TEXTBOOK_COURSE_CREATOR_PERMISSION = _without_manifest_edit(
    COURSE_CREATOR_PERMISSION
)

COURSE_CONTENT_WORKER_PERMISSION = {
    "edit": {
        "**": "deny",
        "**/pipeline/*/course-content/src/data/points/*.json": "allow",
        "**/pipeline/*/course-content/generation/animation-requests/*.json": "allow",
    },
    "skill": {
        "*": "deny",
        "candidate-knowledge-point-generator": "allow",
    },
    "task": "deny",
    "question": "deny",
    "bash": "deny",
    "course_pipeline": "deny",
    "webfetch": "deny",
    "websearch": "deny",
    "doom_loop": "deny",
}

COURSE_ANIMATION_WORKER_PERMISSION = {
    "edit": {
        "**": "deny",
        "**/pipeline/*/course-content/src/animations/*.tsx": "allow",
        "**/pipeline/*/course-content/src/animations/*.css": "allow",
    },
    "skill": {
        "*": "deny",
        "candidate-knowledge-point-generator": "allow",
    },
    "task": "deny",
    "question": "deny",
    "bash": "deny",
    "course_pipeline": "deny",
    "webfetch": "deny",
    "websearch": "deny",
    "doom_loop": "deny",
}

def _course_agents() -> dict:
    return {
        "course-outline-creator": {
            "description": "生成并校验课程范围与完整知识点清单，停在 G2 结构化审核",
            "mode": "primary",
            "permission": COURSE_OUTLINE_CREATOR_PERMISSION,
        },
        "course-creator": {
            "description": "在知识点审核通过后生成课程详情、动画与图谱并发布",
            "mode": "primary",
            "permission": COURSE_CREATOR_PERMISSION,
        },
        "textbook-outline-creator": {
            "description": "Generate and validate a textbook-grounded outline, stopping at G2 review.",
            "mode": "primary",
            "permission": TEXTBOOK_OUTLINE_CREATOR_PERMISSION,
        },
        "textbook-course-creator": {
            "description": "Continue a textbook-grounded course after G2 review and publish it.",
            "mode": "primary",
            "permission": TEXTBOOK_COURSE_CREATOR_PERMISSION,
        },
        "course-content-worker": {
            "description": "按冻结索引生成自己负责的知识点详情与同名动画请求",
            "mode": "subagent",
            "permission": COURSE_CONTENT_WORKER_PERMISSION,
        },
        "course-animation-worker": {
            "description": "按动画清单生成自己负责的教学动画 TSX 与 CSS 组件",
            "mode": "subagent",
            "permission": COURSE_ANIMATION_WORKER_PERMISSION,
        },
    }


def _models_from_file(data: dict) -> list[dict]:
    out = []
    for item in data.get("models", []):
        mid = (item.get("id") or "").strip()
        if not mid:
            continue
        out.append({
            "id": mid,
            "base_url": (item.get("base_url") or "").strip(),
            "api_key": (item.get("api_key") or "").strip(),
        })
    return out


def _models_from_env() -> list[dict]:
    ids = [m.strip() for m in os.environ.get("GATEWAY_MODELS", "").split(",") if m.strip()]
    if not ids:
        d = os.environ.get("DEFAULT_MODEL", "").strip()
        ids = [d] if d else []
    base_url = (
        os.environ.get("OPENCODE_PROVIDER_BASE_URL")
        or os.environ.get("GATEWAY_URL")
        or os.environ.get("AGENT_BASE_URL")
        or ""
    ).strip()
    api_key = (
        os.environ.get("GATEWAY_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY")
        or ""
    ).strip()
    return [{"id": mid, "base_url": base_url, "api_key": api_key} for mid in ids]


def _default_id(data: dict | None, models: list[dict]) -> str:
    if data:
        declared = (data.get("default") or "").strip()
        if declared and any(m["id"] == declared for m in models):
            return declared
    env_default = os.environ.get("DEFAULT_MODEL", "").strip()
    if env_default and any(m["id"] == env_default for m in models):
        return env_default
    return models[0]["id"] if models else ""


def _build_config(models: list[dict], default_id: str) -> dict:
    providers = {}
    for model in models:
        model_id = model["id"]
        providers[model_id] = {
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": model["base_url"],
                "apiKey": model["api_key"],
            },
            "models": {model_id: _model_caps(model_id)},
        }

    return {
        "$schema": "https://opencode.ai/config.json",
        "provider": providers,
        "model": f"{default_id}/{default_id}",
        "compaction": {
            "auto": COMPACTION["auto"],
            "keep": dict(COMPACTION["keep"]),
            "buffer": COMPACTION["buffer"],
            "reserved": COMPACTION["reserved"],
        },
        "permission": PERMISSION,
        "agent": _course_agents(),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: gen_opencode_config.py <output_path>", file=sys.stderr)
        return 2
    out_path = Path(sys.argv[1])

    data = None
    if MODELS_FILE.exists():
        try:
            data = json.loads(MODELS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"models.json 解析失败：{exc}", file=sys.stderr)
            return 1

    models = _models_from_file(data) if data else _models_from_env()
    models = [m for m in models if m["base_url"] and m["api_key"]]
    if not models:
        print("没有可用模型：请配置 models.json 或 GATEWAY_* 环境变量。", file=sys.stderr)
        return 1

    default_id = _default_id(data, models)

    config = _build_config(models, default_id)

    out_path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    ids = ", ".join(m["id"] for m in models)
    print(f"opencode 配置已生成：{out_path}（默认={default_id}，模型=[{ids}]）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
