"""Provision restricted OpenCode workspaces for course-data editing.

The canonical course packages live outside ``generated``.  Each OpenCode
conversation receives a private staged copy under ``course_agent_sessions``;
the course store validates and promotes that copy only after a successful turn.
"""

from __future__ import annotations

import json
from pathlib import Path

from ...config import settings
from ..ai import model_config
from ..courses import CourseWorkspace, get_course_store


ROOT_CONFIG_NAME = "opencode.json"
AGENTS_FILE_NAME = "AGENTS.md"
_SYSTEM_PROMPT_PATH = (
    Path(__file__).resolve().parents[1] / "ai" / "prompts" / "system_course_agent.md"
)


def opencode_root() -> Path:
    """The directory passed to ``opencode serve`` by the launcher scripts."""

    root = settings.course_agent_workspace_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def build_root_config() -> dict:
    """Return a least-privilege config for course JSON workspaces.

    The launcher scripts generate the server-start config as well.  Keeping the
    equivalent definition here makes local programmatic provisioning and
    deployments that call this helper behave the same way.
    """

    models = [model for model in model_config.load_models() if model.base_url and model.api_key]
    configured_default = model_config.default_model_id()
    allowed = {model.id for model in models}
    default_model = configured_default if configured_default in allowed else (
        models[0].id if models else configured_default
    )
    providers = {
        model.id: {
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": model.base_url, "apiKey": model.api_key},
            "models": {
                model.id: {
                    "attachment": True,
                    "tool_call": True,
                    "modalities": {"input": ["text", "image"], "output": ["text"]},
                }
            },
        }
        for model in models
    }
    return {
        "$schema": "https://opencode.ai/config.json",
        "provider": providers,
        "model": f"{default_model}/{default_model}",
        "permission": {
            "edit": {
                "**/course.json": "allow",
                "**/index.json": "allow",
                "**/points/*.json": "allow",
                "**": "deny",
            },
            "skill": {"*": "allow"},
            "question": "deny",
            "bash": "deny",
            "webfetch": "deny",
        },
    }


def write_root_config() -> Path:
    """Write a local config for deployments that do not use the helper script."""

    config_path = opencode_root() / ROOT_CONFIG_NAME
    config_path.write_text(
        json.dumps(build_root_config(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return config_path


def _agents_md() -> str:
    return _SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


def ensure_course_session_assets(conversation_id: str) -> CourseWorkspace:
    """Create/reuse the staged course-data copy and its agent instructions."""

    workspace = get_course_store().prepare_workspace(conversation_id)
    # Keep instructions one level above ``courses`` so validation only sees
    # allowed JSON package files. OpenCode discovers AGENTS.md from parents.
    agents_file = workspace.path.parent / AGENTS_FILE_NAME
    agents_file.write_text(_agents_md(), encoding="utf-8")
    return workspace


def host_course_workspace_dir(workspace: CourseWorkspace) -> str:
    """Translate a staged path when backend and OpenCode use different roots."""

    host_root = settings.opencode_course_host_root.strip()
    if not host_root:
        return str(workspace.path)
    conversation_dir = workspace.path.parent.name
    return str(Path(host_root) / conversation_dir / "courses")


# Small compatibility aliases for integrations that imported the old helper.
def ensure_session_assets(conversation_id: str) -> CourseWorkspace:
    return ensure_course_session_assets(conversation_id)


def host_session_dir(conversation_id: str) -> str:
    return host_course_workspace_dir(ensure_course_session_assets(conversation_id))
