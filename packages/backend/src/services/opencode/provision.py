"""Provision restricted OpenCode workspaces for course-data editing.

The canonical course packages live outside ``generated``.  Each OpenCode
conversation receives a private staged copy under ``course_agent_sessions``;
the course store validates and promotes that copy only after a successful turn.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path

from ...config import PROJECT_ROOT, settings
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
_PROJECT_ROOT = PROJECT_ROOT
_PROJECT_SKILLS_PATH = _PROJECT_ROOT / "skills"
_COURSE_CREATION_SKILLS = (
    ("textbook-outline-generator", Path("SKILL.md")),
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
    "prepare-course-review.mjs",
    "publish-course-pipeline.mjs",
    "run-course-pipeline-step.mjs",
    "validate-textbook-outline.mjs",
)
_COURSE_PIPELINE_TOOL_SOURCE = (
    _PROJECT_ROOT / ".opencode" / "tools" / "course_pipeline.ts"
)
_SHARED_OPENCODE_NODE_MODULES = _PROJECT_ROOT / ".opencode" / "node_modules"

# These custom OpenAI-compatible providers have no Models.dev metadata for
# OpenCode to consult. A ``limit`` declared in models.json always wins; when
# absent, only the verified Kimi K2 window gets a default so automatic
# compaction has a real input budget instead of ``context: 0``. Other vendors
# stay unset rather than guessed.
_KIMI_256K_MODEL_IDS = frozenset({
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2-0905-preview",
    "kimi-k2-turbo-preview",
})
_KIMI_256K_LIMIT = {"context": 262_144, "output": 32_768}
_COMPACTION = {
    "auto": True,
    "keep": {"tokens": 15_000},
    "buffer": 20_000,
    # OpenCode 1.18.x uses this deprecated name for ``buffer``. Keeping the
    # values equal makes the config effective before and after an upgrade.
    "reserved": 20_000,
}


def _model_capabilities(model_id: str, limit: dict | None = None) -> dict:
    capabilities = {
        "attachment": True,
        "tool_call": True,
        "modalities": {"input": ["text", "image"], "output": ["text"]},
    }
    if limit is not None:
        capabilities["limit"] = dict(limit)
    elif model_id in _KIMI_256K_MODEL_IDS:
        capabilities["limit"] = dict(_KIMI_256K_LIMIT)
    return capabilities


def _seed_session_opencode_runtime(session_root: Path) -> bool:
    """Seed a normal session dependency tree with filesystem hard links.

    OpenCode runs its dependency installer for every session-local
    ``.opencode`` directory.  The launcher pre-warms the matching dependency
    tree once at project level; hard-linking those ordinary files gives Bun a
    complete, version-matched install without copying roughly 55 MB per
    conversation.  Skills and trusted tools remain private to the session.

    Hard links need no Windows elevation and deleting a session only decrements
    link counts. If the filesystem cannot create them (for example across
    volumes), returning ``False`` preserves OpenCode's original install path.
    """

    source = _SHARED_OPENCODE_NODE_MODULES
    source_plugin = source / "@opencode-ai" / "plugin" / "package.json"
    runtime_package = source.parent / "package.json"
    if (
        not source.is_dir()
        or source.is_symlink()
        or not source_plugin.is_file()
        or source_plugin.is_symlink()
        or not runtime_package.is_file()
        or runtime_package.is_symlink()
    ):
        return False
    try:
        source_package = json.loads(source_plugin.read_text(encoding="utf-8"))
        runtime = json.loads(runtime_package.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(source_package, dict) or not isinstance(runtime, dict):
        return False
    dependencies = runtime.get("dependencies")
    if not isinstance(dependencies, dict):
        return False
    source_version = source_package.get("version")
    expected_version = dependencies.get("@opencode-ai/plugin")
    if (
        not isinstance(source_version, str)
        or not source_version
        or expected_version != source_version
    ):
        return False

    opencode_dir = session_root / ".opencode"
    destination = opencode_dir / "node_modules"
    if destination.exists() or destination.is_symlink():
        # Preserve resumed sessions and never replace a running private install.
        return False

    # Keep the staging component shorter than "node_modules": Windows course
    # session paths are already long, and the copied dependency tree is deep.
    temporary = opencode_dir / f".n-{uuid.uuid4().hex[:6]}"
    try:
        shutil.copytree(source, temporary, copy_function=os.link, symlinks=True)
        seeded_plugin = temporary / "@opencode-ai" / "plugin" / "package.json"
        seeded_package = json.loads(seeded_plugin.read_text(encoding="utf-8"))
        if seeded_package.get("version") != source_version:
            raise OSError("Seeded OpenCode runtime version changed during copy")
        if not os.path.samefile(source_plugin, seeded_plugin):
            raise OSError("Seeded OpenCode runtime is not hard-linked")
        os.replace(temporary, destination)
        return True
    except (OSError, json.JSONDecodeError, shutil.Error):
        shutil.rmtree(temporary, ignore_errors=True)
        return False


def _course_outline_creator_permission(*, allow_manifest: bool = True) -> dict:
    """Machine gate for G0-G2: only the identity-bearing outline may change."""

    edit = {
        "**": "deny",
        "**/pipeline/*/course-content/src/data/course.json": "allow",
        "**/pipeline/*/course-content/src/data/index.json": "allow",
        "**/pipeline/*/textbook-outline.json": "allow",
    }
    if allow_manifest:
        edit["**/pipeline/*/course-content/generation/manifest.json"] = "allow"
    return {
        "edit": edit,
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


def _course_creator_permission(*, allow_manifest: bool = True) -> dict:
    """Permissions granted only to the isolated course creation agent."""

    edit = {
        "**": "deny",
        "**/pipeline/*/course-content/src/data/course.json": "allow",
        "**/pipeline/*/course-content/src/data/index.json": "allow",
        "**/pipeline/*/course-content/generation/animation-manifest.json": "allow",
        "**/pipeline/*/clustered-graph.json": "allow",
        "**/pipeline/*/textbook-outline.json": "allow",
    }
    if allow_manifest:
        edit["**/pipeline/*/course-content/generation/manifest.json"] = "allow"
    return {
        "edit": edit,
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
        "course_pipeline": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "doom_loop": "deny",
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
            "models": {model.id: _model_capabilities(model.id, model.limit)},
        }
        for model in models
    }
    return {
        "$schema": "https://opencode.ai/config.json",
        "provider": providers,
        "model": f"{default_model}/{default_model}",
        "compaction": {
            "auto": _COMPACTION["auto"],
            "keep": dict(_COMPACTION["keep"]),
            "buffer": _COMPACTION["buffer"],
            "reserved": _COMPACTION["reserved"],
        },
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
            "course_pipeline": "deny",
            "webfetch": "deny",
            "doom_loop": "deny",
        },
        "agent": {
            "course-outline-creator": {
                "description": "生成并校验课程范围与完整知识点清单，停在 G2 结构化审核",
                "mode": "primary",
                "permission": _course_outline_creator_permission(),
            },
            "course-creator": {
                "description": "在知识点审核通过后生成课程详情、动画与图谱并发布",
                "mode": "primary",
                "permission": _course_creator_permission(),
            },
            "textbook-outline-creator": {
                "description": "Generate and validate a textbook-grounded outline, stopping at G2 review.",
                "mode": "primary",
                "permission": _course_outline_creator_permission(allow_manifest=False),
            },
            "textbook-course-creator": {
                "description": "Continue a textbook-grounded course after G2 review and publish it.",
                "mode": "primary",
                "permission": _course_creator_permission(allow_manifest=False),
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

    if not _COURSE_PIPELINE_TOOL_SOURCE.is_file():
        raise FileNotFoundError(
            f"课程创建结构化工具缺失：{_COURSE_PIPELINE_TOOL_SOURCE}"
        )
    # The project-level structured tool is loaded once by OpenCode. A
    # session-local copy can shadow it and leave old review logic cached.
    session_pipeline_tool = tools_target / "course_pipeline.ts"
    if session_pipeline_tool.is_symlink() or session_pipeline_tool.is_file():
        session_pipeline_tool.unlink()
    elif session_pipeline_tool.exists():
        raise RuntimeError(
            f"课程会话中的结构化工具路径不是普通文件：{session_pipeline_tool}"
        )

    _seed_session_opencode_runtime(session_root)
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
