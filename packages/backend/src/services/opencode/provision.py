"""Provision restricted OpenCode workspaces for course-data editing.

The canonical course packages live outside ``generated``.  Each OpenCode
conversation receives a private staged copy under ``course_agent_sessions``;
the course store validates and promotes that copy only after a successful turn.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
import uuid

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
)
_COURSE_PIPELINE_TOOL_SOURCE = (
    _PROJECT_ROOT / ".opencode" / "tools" / "course_pipeline.ts"
)
_SESSION_ASSET_MANIFEST = ".course-studio-assets.json"
_SESSION_ASSET_SCHEMA = "course-session-assets/1.0"


def _course_outline_creator_permission() -> dict:
    """Machine gate for G0-G2: only the identity-bearing outline may change."""

    return {
        "edit": {
            "**": "deny",
            "**/pipeline/*/course-content/src/data/course.json": "allow",
            "**/pipeline/*/course-content/src/data/index.json": "allow",
            "**/pipeline/*/course-content/generation/manifest.json": "allow",
        },
        "skill": {
            "*": "deny",
            "candidate-knowledge-point-generator": "allow",
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


def _course_creator_permission() -> dict:
    """Permissions granted only to the isolated course creation agent."""

    return {
        "edit": {
            "**": "deny",
            "**/pipeline/*/course-content/src/data/course.json": "allow",
            "**/pipeline/*/course-content/src/data/index.json": "allow",
            "**/pipeline/*/course-content/generation/manifest.json": "allow",
            "**/pipeline/*/course-content/generation/animation-manifest.json": "allow",
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


def _write_if_changed(path: Path, content: bytes) -> bool:
    try:
        if path.is_file() and not path.is_symlink() and path.read_bytes() == content:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _tree_content_version(source: Path) -> tuple[str, list[str]]:
    digest = hashlib.sha256()
    files: list[str] = []
    for path in sorted(source.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_dir() and not path.is_symlink():
            continue
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(f"课程创建资源包含不支持的链接或文件：{path}")
        relative = path.relative_to(source).as_posix()
        content = path.read_bytes()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
        files.append(relative)
    return digest.hexdigest(), files


def _target_tree_matches(
    target: Path,
    source_version: str,
    files: list[str],
) -> bool:
    if target.is_symlink() or not target.is_dir():
        return False
    try:
        target_version, actual = _tree_content_version(target)
    except (FileNotFoundError, OSError):
        return False
    return actual == files and target_version == source_version


def _read_asset_manifest(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict) or value.get("schema_version") != _SESSION_ASSET_SCHEMA:
        return {}
    return value


def _replace_tree(source: Path, target: Path) -> None:
    # Keep swap directory names shorter than the final Skill directory.  The
    # production session root is already fairly deep on Windows; repeating a
    # long Skill name plus a full UUID pushed otherwise valid files beyond the
    # legacy MAX_PATH boundary during ``copytree``.
    swap_id = uuid.uuid4().hex[:8]
    temporary = target.parent / f".new-{swap_id}"
    backup = target.parent / f".old-{swap_id}"
    try:
        shutil.copytree(source, temporary)
        had_target = target.exists() or target.is_symlink()
        if had_target:
            os.replace(target, backup)
        try:
            os.replace(temporary, target)
        except BaseException:
            if had_target and backup.exists():
                os.replace(backup, target)
            raise
        if backup.is_dir() and not backup.is_symlink():
            shutil.rmtree(backup)
        elif backup.exists() or backup.is_symlink():
            backup.unlink()
    finally:
        if temporary.is_dir() and not temporary.is_symlink():
            shutil.rmtree(temporary, ignore_errors=True)
        elif temporary.exists() or temporary.is_symlink():
            temporary.unlink(missing_ok=True)
        if backup.exists() or backup.is_symlink():
            # Never discard the only intact copy when both installation and
            # rollback failed. A later provisioning attempt can safely report
            # or recover that backup instead of silently losing the Skill.
            safe_to_remove = True
            if not (target.exists() or target.is_symlink()):
                try:
                    os.replace(backup, target)
                except OSError:
                    safe_to_remove = False
            if safe_to_remove:
                if backup.is_dir() and not backup.is_symlink():
                    shutil.rmtree(backup, ignore_errors=True)
                elif backup.exists() or backup.is_symlink():
                    backup.unlink(missing_ok=True)


def ensure_course_session_assets(conversation_id: str) -> CourseWorkspace:
    """Create/reuse the staged course-data copy and its agent instructions."""

    workspace = get_course_store().prepare_workspace(conversation_id)
    # Keep instructions one level above ``courses`` so validation only sees
    # allowed JSON package files. OpenCode discovers AGENTS.md from parents.
    agents_file = workspace.path.parent / AGENTS_FILE_NAME
    _write_if_changed(agents_file, _agents_md().encode("utf-8"))
    return workspace


def ensure_course_chat_session_assets(conversation_id: str) -> CourseWorkspace:
    """Create a disposable, read-only course snapshot for a Chat turn."""

    workspace = get_course_store().prepare_readonly_workspace(conversation_id)
    agents_file = workspace.path.parent / AGENTS_FILE_NAME
    _write_if_changed(
        agents_file,
        _CHAT_PROMPT_PATH.read_bytes(),
    )
    return workspace


def ensure_course_creation_session_assets(conversation_id: str) -> CourseWorkspace:
    """Prepare the isolated workspace, three pipeline Skills, and release tools."""

    workspace = get_course_store().prepare_workspace(conversation_id)
    session_root = workspace.path.parent
    _write_if_changed(
        session_root / AGENTS_FILE_NAME,
        _COURSE_CREATOR_PROMPT_PATH.read_bytes(),
    )

    asset_manifest_path = session_root / ".opencode" / _SESSION_ASSET_MANIFEST
    installed_assets = _read_asset_manifest(asset_manifest_path)
    installed_skills = installed_assets.get("skills")
    if not isinstance(installed_skills, dict):
        installed_skills = {}
    next_skills: dict[str, dict[str, object]] = {}
    next_tools: dict[str, str] = {}
    next_manifest: dict[str, object] = {
        "schema_version": _SESSION_ASSET_SCHEMA,
        "skills": next_skills,
        "tools": next_tools,
    }

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

        source_version, source_files = _tree_content_version(source)
        installed = installed_skills.get(skill_name)
        can_reuse = (
            isinstance(installed, dict)
            and installed.get("sha256") == source_version
            and installed.get("files") == source_files
            and _target_tree_matches(target, source_version, source_files)
        )
        if not can_reuse:
            _replace_tree(source, target)
        next_skills[skill_name] = {
            "sha256": source_version,
            "files": source_files,
        }

    tools_target = session_root / ".opencode" / "tools"
    tools_target.mkdir(parents=True, exist_ok=True)
    for file_name in _COURSE_CREATION_TOOLS:
        source = _PROJECT_ROOT / "scripts" / file_name
        if not source.is_file():
            raise FileNotFoundError(f"课程创建工具缺失：{source}")
        source_bytes = source.read_bytes()
        source_version = hashlib.sha256(source_bytes).hexdigest()
        target = tools_target / file_name
        _write_if_changed(target, source_bytes)
        next_tools[file_name] = source_version

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

    _write_if_changed(
        asset_manifest_path,
        (
            json.dumps(next_manifest, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n"
        ).encode("utf-8"),
    )
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
