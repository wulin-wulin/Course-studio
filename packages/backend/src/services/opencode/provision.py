"""Provision restricted OpenCode workspaces for course-data editing.

The canonical course packages live outside ``generated``.  Each OpenCode
conversation receives a private staged copy under ``course_agent_sessions``;
the course store validates and promotes that copy only after a successful turn.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from ...config import settings
from ..ai import model_config
from ..courses import CourseWorkspace, get_course_store


ROOT_CONFIG_NAME = "opencode.json"
AGENTS_FILE_NAME = "AGENTS.md"
_SYSTEM_PROMPT_PATH = (
    Path(__file__).resolve().parents[1] / "ai" / "prompts" / "system_course_agent.md"
)
_CHAT_PROMPT_PATH = (
    Path(__file__).resolve().parents[1] / "ai" / "prompts" / "system_course_chat.md"
)
_COURSE_CREATOR_PROMPT_PATH = (
    Path(__file__).resolve().parents[1] / "ai" / "prompts" / "system_course_creator.md"
)
_PROJECT_ROOT = Path(__file__).resolve().parents[5]
_PROJECT_SKILLS_PATH = _PROJECT_ROOT / "skills"
_COURSE_CREATION_SKILLS = (
    ("candidate-knowledge-point-generator", Path("SKILL.md")),
    (
        "knowledge-cluster-builder",
        Path("knowledge-cluster-builder") / "SKILL.md",
    ),
    ("knowledge-pipeline-orchestrator", Path("SKILL.md")),
)
_COURSE_CREATION_TOOLS = (
    "bundle-course-animations.mjs",
    "init-course-pipeline.mjs",
    "layout-course-map.mjs",
    "publish-course-pipeline.mjs",
)


def _course_creator_permission() -> dict:
    """Permissions granted only to the isolated course creation agent."""

    return {
        "edit": {
            "**": "deny",
            "**/pipeline/*/course-content/**": "allow",
            "**/pipeline/*/clustered-graph.json": "allow",
        },
        "skill": {
            "*": "deny",
            "candidate-knowledge-point-generator": "allow",
            "knowledge-cluster-builder": "allow",
            "knowledge-pipeline-orchestrator": "allow",
        },
        "task": {
            "*": "deny",
            "course-content-worker": "allow",
            "course-animation-worker": "allow",
        },
        "question": "allow",
        "bash": {
            "*": "deny",
            "node *init-course-pipeline.mjs*": "allow",
            "node *validate_output.mjs*": "allow",
            "node *sync_index_from_points.mjs*": "allow",
            "node *build_animation_registry.mjs*": "allow",
            "node *assemble-graph-points.mjs*": "allow",
            "node *check-graph.mjs*": "allow",
            "node *check-pipeline.mjs*": "allow",
            "node *publish-course-pipeline.mjs*": "allow",
            "node --test *candidate-knowledge-point-generator/scripts/*.test.mjs": "allow",
        },
        "webfetch": "allow",
        "websearch": "allow",
    }


def _course_worker_permission(*edit_patterns: str) -> dict:
    """Least-privilege permissions for v2 content-generation subagents."""

    return {
        "edit": {"**": "deny", **{pattern: "allow" for pattern in edit_patterns}},
        "skill": {
            "*": "deny",
            "candidate-knowledge-point-generator": "allow",
        },
        "task": "deny",
        "question": "deny",
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
    }


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
                "**": "deny",
                "**/course.json": "allow",
                "**/index.json": "allow",
                "**/points/*.json": "allow",
            },
            "skill": {"*": "allow"},
            "question": "deny",
            "bash": "deny",
            "webfetch": "deny",
        },
        "agent": {
            "course-creator": {
                "description": "按照项目 Skill 流程引导用户创建并发布课程",
                "mode": "primary",
                "permission": _course_creator_permission(),
            },
            "course-content-worker": {
                "description": "按冻结索引生成自己负责的知识点详情与同名动画请求",
                "mode": "subagent",
                "permission": _course_worker_permission(
                    "**/pipeline/*/course-content/src/data/points/*.json",
                    "**/pipeline/*/course-content/generation/animation-requests/*.json",
                ),
            },
            "course-animation-worker": {
                "description": "按动画清单生成自己负责的教学动画 TSX 与 CSS 组件",
                "mode": "subagent",
                "permission": _course_worker_permission(
                    "**/pipeline/*/course-content/src/animations/*.tsx",
                    "**/pipeline/*/course-content/src/animations/*.css",
                ),
            },
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


def ensure_course_chat_session_assets(conversation_id: str) -> CourseWorkspace:
    """Create a disposable, read-only course snapshot for a Chat turn."""

    workspace = get_course_store().prepare_readonly_workspace(conversation_id)
    agents_file = workspace.path.parent / AGENTS_FILE_NAME
    agents_file.write_text(_CHAT_PROMPT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    return workspace


def ensure_course_creation_session_assets(conversation_id: str) -> CourseWorkspace:
    """Prepare the isolated workspace, three pipeline Skills, and release tools."""

    workspace = get_course_store().prepare_workspace(conversation_id)
    session_root = workspace.path.parent
    (session_root / AGENTS_FILE_NAME).write_text(
        _COURSE_CREATOR_PROMPT_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    skills_target = session_root / ".opencode" / "skills"
    skills_target.mkdir(parents=True, exist_ok=True)
    resolved_skills_target = skills_target.resolve()
    for skill_name, manifest_path in _COURSE_CREATION_SKILLS:
        source = _PROJECT_SKILLS_PATH / skill_name
        if not (source / manifest_path).is_file():
            raise FileNotFoundError(f"课程创建 Skill 不完整：{source}")
        target = skills_target / skill_name
        resolved_target = target.resolve()
        try:
            resolved_target.relative_to(resolved_skills_target)
        except ValueError as exc:
            raise RuntimeError(
                f"Course creation Skill target escapes the session directory: {target}"
            ) from exc
        if resolved_target == resolved_skills_target:
            raise RuntimeError(f"Invalid course creation Skill target: {target}")

        if target.exists() or target.is_symlink():
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.copytree(source, target)

    tools_target = session_root / ".opencode" / "tools"
    tools_target.mkdir(parents=True, exist_ok=True)
    for file_name in _COURSE_CREATION_TOOLS:
        source = _PROJECT_ROOT / "scripts" / file_name
        if not source.is_file():
            raise FileNotFoundError(f"课程创建工具缺失：{source}")
        shutil.copy2(source, tools_target / file_name)

    (session_root / "pipeline").mkdir(parents=True, exist_ok=True)
    return workspace


def restore_course_chat_session(workspace: CourseWorkspace) -> None:
    """Discard any file changes attempted during a read-only Chat turn."""

    get_course_store().restore_readonly_workspace(workspace)


def host_course_workspace_dir(workspace: CourseWorkspace) -> str:
    """Translate a staged path when backend and OpenCode use different roots."""

    host_root = settings.opencode_course_host_root.strip()
    if not host_root:
        return str(workspace.path)
    conversation_dir = workspace.path.parent.name
    return str(Path(host_root) / conversation_dir / "courses")


def host_course_creation_workspace_dir(workspace: CourseWorkspace) -> str:
    """Translate the session root used by the course creation workflow."""

    host_root = settings.opencode_course_host_root.strip()
    if not host_root:
        return str(workspace.path.parent)
    return str(Path(host_root) / workspace.path.parent.name)


# Small compatibility aliases for integrations that imported the old helper.
def ensure_session_assets(conversation_id: str) -> CourseWorkspace:
    return ensure_course_session_assets(conversation_id)


def host_session_dir(conversation_id: str) -> str:
    return host_course_workspace_dir(ensure_course_session_assets(conversation_id))
