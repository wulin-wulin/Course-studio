"""Safe JSON storage for CKDS-compatible course packages.

Course content is deliberately stored as ordinary JSON, with optional compiled
animation assets. This service is the single writer for the canonical package
directory and provides three safeguards:

* paths are constrained to the course JSON contract plus three fixed,
  integrity-checked files under ``<course-id>/animations``;
* all candidates are parsed and validated before they reach the canonical tree;
* writes use temporary files plus ``os.replace`` while holding a process lock.

OpenCode itself writes a per-conversation staging copy.  ``commit_workspace``
validates that copy and synchronises it only if the canonical tree has not
changed since the workspace was created.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
from typing import Any, Iterable

from ...config import settings


_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ANIMATION_TYPE_RE = re.compile(r"^[a-z][A-Za-z0-9]*$")
_COMPONENT_RE = re.compile(r"^[A-Z][A-Za-z0-9]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_JSON_BYTES = 8 * 1024 * 1024
_ANIMATION_RUNTIME_SCHEMA = "course-animation-runtime/1.0"
_ANIMATION_ASSET_FILES = frozenset({"manifest.json", "runtime.js", "runtime.css"})
_POINT_META_FIELDS = (
    "id",
    "title",
    "clusterId",
    "shortSummary",
    "difficulty",
    "importance",
    "keyTerms",
    "pos",
    "scale",
)
_DEFAULT_COLORS = (
    ("#2f9e7e", "#dff7ed", "#175c49"),
    ("#d97706", "#fff0cf", "#7a3d02"),
    ("#7c5cff", "#ece8ff", "#4430a6"),
    ("#2563eb", "#dbeafe", "#1e3a8a"),
    ("#be185d", "#fce7f3", "#831843"),
)


class CourseDataError(RuntimeError):
    """The request cannot be safely represented as course data."""


class CourseNotFoundError(CourseDataError):
    """The requested course or knowledge point does not exist."""


class CourseConflictError(CourseDataError):
    """A staging workspace is based on stale canonical data."""


class CourseValidationError(CourseDataError):
    """A candidate package failed validation before a commit."""

    def __init__(self, errors: Iterable[str], warnings: Iterable[str] = ()):
        self.errors = list(errors)
        self.warnings = list(warnings)
        detail = "; ".join(self.errors[:4]) or "课程数据校验失败"
        super().__init__(detail)


@dataclass(slots=True)
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True, slots=True)
class CourseWorkspace:
    """A staged copy of every course package for one agent conversation."""

    conversation_id: str
    path: Path
    base_fingerprint: str


def _safe_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise CourseDataError(f"{label} 必须是小写 kebab-case 标识符")
    return value


def _safe_conversation_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)
    return cleaned[:80] or "default"


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _deepcopy_json(value: Any) -> Any:
    """Copy JSON-compatible values without retaining caller-owned containers."""

    return json.loads(json.dumps(value, ensure_ascii=False))


class CourseStore:
    """Read, validate, mutate, and commit JSON course packages."""

    def __init__(self, root: Path | None = None, workspace_root: Path | None = None):
        self.root = (root or settings.course_data_dir).resolve()
        self.workspace_root = (workspace_root or settings.course_agent_workspace_dir).resolve()
        self._lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Safe paths and raw JSON I/O
    # ------------------------------------------------------------------

    def _within(self, root: Path, path: Path) -> Path:
        resolved_root = root.resolve()
        resolved_path = path.resolve()
        if not resolved_path.is_relative_to(resolved_root):
            raise CourseDataError("课程数据路径超出受限工作区")
        return resolved_path

    def _course_dir(self, course_id: str, *, root: Path | None = None, required: bool = True) -> Path:
        cid = _safe_id(course_id, "course_id")
        base = (root or self.root).resolve()
        path = self._within(base, base / cid)
        if required and (not path.is_dir() or path.is_symlink()):
            raise CourseNotFoundError(f"课程不存在：{cid}")
        return path

    def _point_path(
        self,
        course_id: str,
        point_id: str,
        *,
        root: Path | None = None,
        required: bool = True,
    ) -> Path:
        pid = _safe_id(point_id, "point_id")
        directory = self._course_dir(course_id, root=root, required=required)
        path = self._within(directory, directory / "points" / f"{pid}.json")
        if required and (not path.is_file() or path.is_symlink()):
            raise CourseNotFoundError(f"知识点不存在：{pid}")
        return path

    def _animation_dir(
        self,
        course_id: str,
        *,
        root: Path | None = None,
        required: bool = True,
    ) -> Path:
        directory = self._course_dir(course_id, root=root, required=required)
        path = self._within(directory, directory / "animations")
        if required and (not path.is_dir() or path.is_symlink()):
            raise CourseNotFoundError(f"课程没有可用动画：{course_id}")
        return path

    def _animation_asset_path(
        self,
        course_id: str,
        file_name: str,
        *,
        root: Path | None = None,
    ) -> Path:
        if file_name not in _ANIMATION_ASSET_FILES:
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        directory = self._animation_dir(course_id, root=root)
        path = self._within(directory, directory / file_name)
        if not path.is_file() or path.is_symlink():
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        return path

    def _read_json(self, path: Path, *, root: Path | None = None) -> dict[str, Any]:
        if root is not None:
            self._within(root, path)
        if not path.is_file() or path.is_symlink():
            raise CourseNotFoundError(f"数据文件不存在：{path.name}")
        if path.stat().st_size > _MAX_JSON_BYTES:
            raise CourseDataError(f"数据文件过大：{path.name}")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CourseDataError(f"JSON 解析失败：{path.name}: {exc.msg}") from exc
        except OSError as exc:
            raise CourseDataError(f"无法读取数据文件：{path.name}: {exc}") from exc
        if not isinstance(value, dict):
            raise CourseDataError(f"JSON 根节点必须是对象：{path.name}")
        return value

    @staticmethod
    def _revision() -> str:
        return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]

    @staticmethod
    def _today() -> str:
        return datetime.now(UTC).date().isoformat()

    @staticmethod
    def _stored_revision(course: dict[str, Any], fallback: str) -> str:
        """Accept the imported numeric revision while emitting one stable type."""

        value = course.get("revision")
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
        return fallback

    # ------------------------------------------------------------------
    # Public read API
    # ------------------------------------------------------------------

    def list_courses(self) -> list[dict[str, Any]]:
        with self._lock:
            courses: list[dict[str, Any]] = []
            if not self.root.exists():
                return courses
            fallback_revision = self._fingerprint(self.root)
            for directory in sorted(self.root.iterdir(), key=lambda item: item.name):
                if not directory.is_dir() or directory.is_symlink() or not _ID_RE.fullmatch(directory.name):
                    continue
                try:
                    course = self._read_json(directory / "course.json", root=self.root)
                    index = self._read_json(directory / "index.json", root=self.root)
                except CourseDataError:
                    # A malformed package should not make unrelated courses disappear
                    # from the service entirely. It is exposed as invalid instead.
                    courses.append({"id": directory.name, "invalid": True})
                    continue
                courses.append({
                    "id": directory.name,
                    "title": course.get("title", directory.name),
                    "description": course.get("description", ""),
                    "language": course.get("language", "zh-CN"),
                    "revision": self._stored_revision(course, fallback_revision),
                    "clusters": len(index.get("clusters") or []),
                    "points": len(index.get("points") or []),
                })
            return courses

    def read_course(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._course_dir(course_id)
            course = self._read_json(directory / "course.json", root=self.root)
            return _deepcopy_json(course)

    def read_index(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._course_dir(course_id)
            index = self._read_json(directory / "index.json", root=self.root)
            # The source AI course predates CKDS and does not contain courseId.
            # Add it at read time so new consumers always receive a stable shape
            # without modifying the imported source merely by viewing it.
            index = _deepcopy_json(index)
            index.setdefault("schema_version", "1.0")
            index.setdefault("courseId", course_id)
            return index

    def read_point(self, course_id: str, point_id: str) -> dict[str, Any]:
        with self._lock:
            point = self._read_json(self._point_path(course_id, point_id), root=self.root)
            return _deepcopy_json(point)

    def read_animation_manifest(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            _, _, points = self._load_course_objects(self.root, course_id)
            self._animation_dir(course_id, root=self.root)
            validation = self._validate_animation_package(self.root, course_id, points)
            if not validation.ok:
                raise CourseValidationError(validation.errors, validation.warnings)
            manifest = self._read_json(
                self._animation_asset_path(course_id, "manifest.json", root=self.root),
                root=self.root,
            )
            return _deepcopy_json(manifest)

    def read_animation_definition(self, course_id: str, animation_type: str) -> dict[str, Any]:
        if not isinstance(animation_type, str) or not _ANIMATION_TYPE_RE.fullmatch(animation_type):
            raise CourseNotFoundError(f"动画类型不存在：{animation_type}")
        manifest = self.read_animation_manifest(course_id)
        for animation in manifest.get("animations") or []:
            if isinstance(animation, dict) and animation.get("type") == animation_type:
                return _deepcopy_json(animation)
        raise CourseNotFoundError(f"动画类型不存在：{animation_type}")

    def read_animation_asset(self, course_id: str, file_name: str) -> bytes:
        if file_name not in {"runtime.js", "runtime.css"}:
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        with self._lock:
            # Validate hashes before serving executable content. A partial or
            # externally modified package must fail closed instead of running.
            self.read_animation_manifest(course_id)
            path = self._animation_asset_path(course_id, file_name, root=self.root)
            if path.stat().st_size > _MAX_JSON_BYTES:
                raise CourseDataError(f"动画资产过大：{file_name}")
            return path.read_bytes()

    def revision(self, course_id: str) -> str:
        course = self.read_course(course_id)
        return self._stored_revision(course, self._fingerprint(self.root))

    # ------------------------------------------------------------------
    # Package validation
    # ------------------------------------------------------------------

    @staticmethod
    def _is_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    @staticmethod
    def _is_pair(value: Any) -> bool:
        return (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
        )

    def _validate_course_objects(
        self,
        course_id: str,
        course: dict[str, Any],
        index: dict[str, Any],
        points: dict[str, dict[str, Any]],
        *,
        strict_details: bool,
    ) -> ValidationResult:
        result = ValidationResult()
        prefix = f"课程 {course_id}"

        if course.get("id") != course_id:
            result.errors.append(f"{prefix}: course.json 的 id 必须等于目录名")
        if not isinstance(course.get("title"), str) or not course["title"].strip():
            result.errors.append(f"{prefix}: course.json 缺少非空 title")
        if "schema_version" in course and not isinstance(course["schema_version"], str):
            result.errors.append(f"{prefix}: schema_version 必须是字符串")

        if index.get("courseId") not in (None, course_id):
            result.errors.append(f"{prefix}: index.json 的 courseId 与目录名不一致")
        clusters = index.get("clusters")
        indexed_points = index.get("points")
        if not isinstance(clusters, list):
            result.errors.append(f"{prefix}: index.json.clusters 必须是数组")
            clusters = []
        if not isinstance(indexed_points, list):
            result.errors.append(f"{prefix}: index.json.points 必须是数组")
            indexed_points = []

        cluster_ids: set[str] = set()
        for item in clusters:
            if not isinstance(item, dict):
                result.errors.append(f"{prefix}: clusters 中存在非对象")
                continue
            cid = item.get("id")
            if not isinstance(cid, str) or not _ID_RE.fullmatch(cid):
                result.errors.append(f"{prefix}: 知识簇 id 必须为 kebab-case")
                continue
            if cid in cluster_ids:
                result.errors.append(f"{prefix}: 知识簇 id 重复：{cid}")
            cluster_ids.add(cid)
            if not isinstance(item.get("title"), str) or not item["title"].strip():
                result.errors.append(f"{prefix}: 知识簇 {cid} 缺少非空 title")
            for color_name in ("accent", "soft", "dark"):
                color = item.get(color_name)
                if color is not None and (not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
                    result.errors.append(f"{prefix}: 知识簇 {cid}.{color_name} 必须是 #RRGGBB")
            if "labelPos" in item and not self._is_pair(item["labelPos"]):
                result.errors.append(f"{prefix}: 知识簇 {cid}.labelPos 必须是 [x, y]")
            if "polygon" in item:
                polygon = item["polygon"]
                if not isinstance(polygon, list) or any(not self._is_pair(vertex) for vertex in polygon):
                    result.errors.append(f"{prefix}: 知识簇 {cid}.polygon 必须是坐标数组")

        index_by_id: dict[str, dict[str, Any]] = {}
        for item in indexed_points:
            if not isinstance(item, dict):
                result.errors.append(f"{prefix}: points 中存在非对象")
                continue
            pid = item.get("id")
            if not isinstance(pid, str) or not _ID_RE.fullmatch(pid):
                result.errors.append(f"{prefix}: 知识点 id 必须为 kebab-case")
                continue
            if pid in index_by_id:
                result.errors.append(f"{prefix}: 知识点 id 重复：{pid}")
                continue
            index_by_id[pid] = item
            cluster_id = item.get("clusterId")
            if cluster_id not in cluster_ids:
                result.errors.append(f"{prefix}: 知识点 {pid} 引用了不存在的知识簇 {cluster_id}")
            if not isinstance(item.get("title"), str) or not item["title"].strip():
                result.errors.append(f"{prefix}: 知识点 {pid} 缺少非空 title")
            if not isinstance(item.get("shortSummary"), str):
                result.errors.append(f"{prefix}: 知识点 {pid}.shortSummary 必须是字符串")
            difficulty = item.get("difficulty")
            if difficulty not in {"基础", "中等", "进阶"}:
                result.errors.append(f"{prefix}: 知识点 {pid}.difficulty 必须是 基础/中等/进阶")
            importance = item.get("importance")
            if not self._is_number(importance) or not 0 <= float(importance) <= 1:
                result.errors.append(f"{prefix}: 知识点 {pid}.importance 必须在 0 到 1 之间")
            key_terms = item.get("keyTerms")
            if not isinstance(key_terms, list) or any(not isinstance(term, str) for term in key_terms):
                result.errors.append(f"{prefix}: 知识点 {pid}.keyTerms 必须是字符串数组")
            if not self._is_pair(item.get("pos")):
                result.errors.append(f"{prefix}: 知识点 {pid}.pos 必须是 [x, y]")
            scale = item.get("scale")
            if not self._is_number(scale) or float(scale) <= 0:
                result.errors.append(f"{prefix}: 知识点 {pid}.scale 必须大于 0")

        point_ids = set(points)
        indexed_ids = set(index_by_id)
        for missing in sorted(indexed_ids - point_ids):
            result.errors.append(f"{prefix}: index 中的知识点缺少详情文件：{missing}")
        for extra in sorted(point_ids - indexed_ids):
            result.errors.append(f"{prefix}: points 目录存在未索引详情文件：{extra}")

        for pid in sorted(indexed_ids & point_ids):
            detail = points[pid]
            if detail.get("id") != pid:
                result.errors.append(f"{prefix}: points/{pid}.json 的 id 不匹配")
            for field_name in _POINT_META_FIELDS:
                if detail.get(field_name) != index_by_id[pid].get(field_name):
                    message = f"{prefix}: 知识点 {pid} 的 {field_name} 未与 index 同步"
                    # The imported AI Principles package contains a small number
                    # of historical metadata mismatches. Keep it readable while
                    # exposing them to validation; new REST writes always use
                    # strict validation and cannot introduce new mismatches.
                    if strict_details:
                        result.errors.append(message)
                    else:
                        result.warnings.append(message)

            prerequisites = detail.get("prerequisites")
            if prerequisites is None:
                message = f"{prefix}: 知识点 {pid} 缺少 prerequisites（建议写 []）"
                (result.errors if strict_details else result.warnings).append(message)
            elif not isinstance(prerequisites, list) or any(not isinstance(item, str) for item in prerequisites):
                result.errors.append(f"{prefix}: 知识点 {pid}.prerequisites 必须是字符串数组")
            else:
                if len(set(prerequisites)) != len(prerequisites):
                    result.errors.append(f"{prefix}: 知识点 {pid}.prerequisites 不可重复")
                if pid in prerequisites:
                    result.errors.append(f"{prefix}: 知识点 {pid} 不可依赖自身")
                for prerequisite in prerequisites:
                    if prerequisite not in indexed_ids:
                        message = f"{prefix}: 知识点 {pid} 的前置引用不存在：{prerequisite}"
                        (result.errors if strict_details else result.warnings).append(message)

            if strict_details:
                if not isinstance(detail.get("coreIdea"), str) or not detail["coreIdea"].strip():
                    result.errors.append(f"{prefix}: 知识点 {pid} 缺少非空 coreIdea")
                for content_field in ("principles", "applications"):
                    value = detail.get(content_field)
                    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item.strip() for item in value):
                        result.errors.append(f"{prefix}: 知识点 {pid}.{content_field} 必须是非空字符串数组")

        return result

    def _load_course_objects(self, root: Path, course_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
        directory = self._course_dir(course_id, root=root)
        course = self._read_json(directory / "course.json", root=root)
        index = self._read_json(directory / "index.json", root=root)
        points_dir = directory / "points"
        points: dict[str, dict[str, Any]] = {}
        if points_dir.exists():
            if not points_dir.is_dir() or points_dir.is_symlink():
                raise CourseDataError(f"课程 {course_id}: points 必须是目录")
            for path in sorted(points_dir.glob("*.json"), key=lambda item: item.name):
                if path.is_symlink():
                    raise CourseDataError(f"课程 {course_id}: 不允许符号链接 {path.name}")
                point_id = path.stem
                if not _ID_RE.fullmatch(point_id):
                    raise CourseDataError(f"课程 {course_id}: 非法知识点文件名 {path.name}")
                points[point_id] = self._read_json(path, root=root)
        return course, index, points

    def _validate_animation_package(
        self,
        root: Path,
        course_id: str,
        points: dict[str, dict[str, Any]],
    ) -> ValidationResult:
        """Validate an optional, already-compiled sandbox animation bundle."""

        result = ValidationResult()
        course_directory = self._course_dir(course_id, root=root)
        animation_directory = course_directory / "animations"
        if not animation_directory.exists():
            return result
        if not animation_directory.is_dir() or animation_directory.is_symlink():
            result.errors.append(f"课程 {course_id}: animations 必须是普通目录")
            return result

        found: set[str] = set()
        for candidate in animation_directory.iterdir():
            if candidate.is_symlink() or not candidate.is_file():
                result.errors.append(f"课程 {course_id}: animations 不允许目录或符号链接 {candidate.name}")
                continue
            found.add(candidate.name)
        missing = sorted(_ANIMATION_ASSET_FILES - found)
        unexpected = sorted(found - _ANIMATION_ASSET_FILES)
        if missing:
            result.errors.append(f"课程 {course_id}: 动画包缺少 {', '.join(missing)}")
        if unexpected:
            result.errors.append(f"课程 {course_id}: 动画包包含未授权文件 {', '.join(unexpected)}")
        if missing or unexpected:
            return result

        try:
            manifest = self._read_json(animation_directory / "manifest.json", root=root)
        except CourseDataError as exc:
            result.errors.append(f"课程 {course_id}: 动画清单无效：{exc}")
            return result
        if manifest.get("schema_version") != _ANIMATION_RUNTIME_SCHEMA:
            result.errors.append(
                f"课程 {course_id}: 动画清单 schema_version 必须是 {_ANIMATION_RUNTIME_SCHEMA}"
            )
        if manifest.get("format") != "sandboxed-iframe":
            result.errors.append(f"课程 {course_id}: 动画包只能使用 sandboxed-iframe 格式")

        animations = manifest.get("animations")
        if not isinstance(animations, list) or not animations:
            result.errors.append(f"课程 {course_id}: 动画清单 animations 必须是非空数组")
            animations = []
        known_types: set[str] = set()
        bound_points: dict[str, str] = {}
        for animation in animations:
            if not isinstance(animation, dict):
                result.errors.append(f"课程 {course_id}: 动画清单中存在非对象项")
                continue
            animation_type = animation.get("type")
            component = animation.get("component")
            if not isinstance(animation_type, str) or not _ANIMATION_TYPE_RE.fullmatch(animation_type):
                result.errors.append(f"课程 {course_id}: 非法 animationType {animation_type}")
                continue
            if animation_type in known_types:
                result.errors.append(f"课程 {course_id}: animationType 重复 {animation_type}")
            known_types.add(animation_type)
            if not isinstance(component, str) or not _COMPONENT_RE.fullmatch(component):
                result.errors.append(f"课程 {course_id}: 动画 {animation_type} 的组件名无效")
            bindings = animation.get("bindings")
            if not isinstance(bindings, list) or not bindings:
                result.errors.append(f"课程 {course_id}: 动画 {animation_type} 缺少 bindings")
                continue
            for binding in bindings:
                point_id = binding.get("pointId") if isinstance(binding, dict) else None
                if not isinstance(point_id, str) or not _ID_RE.fullmatch(point_id):
                    result.errors.append(f"课程 {course_id}: 动画 {animation_type} 包含非法 pointId")
                    continue
                if point_id in bound_points:
                    result.errors.append(f"课程 {course_id}: 知识点 {point_id} 被多个动画绑定")
                bound_points[point_id] = animation_type
                point = points.get(point_id)
                if point is None:
                    result.errors.append(f"课程 {course_id}: 动画绑定了不存在的知识点 {point_id}")
                elif point.get("animationType") != animation_type:
                    result.errors.append(
                        f"课程 {course_id}: {point_id}.animationType 与动画清单不一致"
                    )

        for point_id, point in points.items():
            animation_type = point.get("animationType")
            if isinstance(animation_type, str) and animation_type != "none":
                if animation_type not in known_types:
                    result.errors.append(
                        f"课程 {course_id}: 知识点 {point_id} 引用了未发布动画 {animation_type}"
                    )
                elif bound_points.get(point_id) != animation_type:
                    result.errors.append(
                        f"课程 {course_id}: 知识点 {point_id} 缺少动画清单绑定"
                    )

        assets = manifest.get("assets")
        if not isinstance(assets, dict):
            result.errors.append(f"课程 {course_id}: 动画清单缺少 assets 完整性信息")
            assets = {}
        for file_name in ("runtime.js", "runtime.css"):
            metadata = assets.get(file_name)
            if not isinstance(metadata, dict):
                result.errors.append(f"课程 {course_id}: 动画清单缺少 {file_name} 完整性信息")
                continue
            asset_path = animation_directory / file_name
            try:
                value = asset_path.read_bytes()
            except OSError as exc:
                result.errors.append(f"课程 {course_id}: 无法读取动画资产 {file_name}：{exc}")
                continue
            expected_bytes = metadata.get("bytes")
            expected_hash = metadata.get("sha256")
            if (
                not isinstance(expected_bytes, int)
                or isinstance(expected_bytes, bool)
                or expected_bytes != len(value)
            ):
                result.errors.append(f"课程 {course_id}: {file_name} 字节数与清单不一致")
            if (
                not isinstance(expected_hash, str)
                or not _SHA256_RE.fullmatch(expected_hash)
                or hashlib.sha256(value).hexdigest() != expected_hash
            ):
                result.errors.append(f"课程 {course_id}: {file_name} 完整性校验失败")
        return result

    def _course_ids_in(self, root: Path) -> list[str]:
        if not root.exists():
            return []
        identifiers: list[str] = []
        for item in root.iterdir():
            if item.is_symlink():
                raise CourseDataError(f"不允许符号链接：{item.name}")
            if not item.is_dir():
                raise CourseDataError(f"课程根目录只允许课程目录：{item.name}")
            identifiers.append(_safe_id(item.name, "course_id"))
        return sorted(identifiers)

    def _validate_root(self, root: Path, *, strict_details: bool) -> ValidationResult:
        result = ValidationResult()
        try:
            course_ids = self._course_ids_in(root)
        except CourseDataError as exc:
            result.errors.append(str(exc))
            return result
        for course_id in course_ids:
            try:
                course, index, points = self._load_course_objects(root, course_id)
            except CourseDataError as exc:
                result.errors.append(str(exc))
                continue
            child = self._validate_course_objects(
                course_id, course, index, points, strict_details=strict_details
            )
            result.errors.extend(child.errors)
            result.warnings.extend(child.warnings)
            animation_child = self._validate_animation_package(root, course_id, points)
            result.errors.extend(animation_child.errors)
            result.warnings.extend(animation_child.warnings)
        return result

    def validate_course(self, course_id: str, *, strict_details: bool = False) -> ValidationResult:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            result = self._validate_course_objects(
                course_id, course, index, points, strict_details=strict_details
            )
            animation_result = self._validate_animation_package(self.root, course_id, points)
            result.errors.extend(animation_result.errors)
            result.warnings.extend(animation_result.warnings)
            return result

    # ------------------------------------------------------------------
    # Atomic writer helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _allowed_relative_path(relative: Path) -> bool:
        parts = relative.parts
        if len(parts) == 2 and _ID_RE.fullmatch(parts[0]) and parts[1] in {"course.json", "index.json"}:
            return True
        if (
            len(parts) == 3
            and _ID_RE.fullmatch(parts[0]) is not None
            and parts[1] == "animations"
            and parts[2] in _ANIMATION_ASSET_FILES
        ):
            return True
        return (
            len(parts) == 3
            and _ID_RE.fullmatch(parts[0]) is not None
            and parts[1] == "points"
            and parts[2].endswith(".json")
            and _ID_RE.fullmatch(parts[2][:-5]) is not None
        )

    def _tree_bytes(self, root: Path) -> dict[Path, bytes]:
        root = root.resolve()
        if not root.exists():
            return {}
        result: dict[Path, bytes] = {}
        for path in root.rglob("*"):
            if path.is_dir():
                continue
            if path.is_symlink():
                raise CourseDataError(f"不允许符号链接：{path.relative_to(root)}")
            relative = path.relative_to(root)
            if not self._allowed_relative_path(relative):
                raise CourseDataError(f"工作区包含不允许的文件：{relative.as_posix()}")
            if path.stat().st_size > _MAX_JSON_BYTES:
                raise CourseDataError(f"数据文件过大：{relative.as_posix()}")
            result[relative] = path.read_bytes()
        return result

    @staticmethod
    def _fingerprint_from_tree(tree: dict[Path, bytes]) -> str:
        digest = hashlib.sha256()
        for relative in sorted(tree, key=lambda item: item.as_posix()):
            digest.update(relative.as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(tree[relative])
            digest.update(b"\0")
        return digest.hexdigest()

    def _fingerprint(self, root: Path) -> str:
        return self._fingerprint_from_tree(self._tree_bytes(root))

    def _atomic_sync_tree(self, destination: Path, desired: dict[Path, bytes]) -> None:
        """Synchronise permitted package files with rollback on a failed replace.

        Individual filesystem replacements are atomic.  A process-wide lock and
        rollback make a multi-file course update behave transactionally for
        normal failures, while all data is already validated before this method
        is called.
        """

        destination.mkdir(parents=True, exist_ok=True)
        existing = self._tree_bytes(destination)
        changed = sorted(
            (set(existing) | set(desired)), key=lambda item: item.as_posix()
        )
        changed = [path for path in changed if existing.get(path) != desired.get(path)]
        if not changed:
            return

        temporary: dict[Path, Path] = {}
        touched: list[Path] = []
        try:
            for relative in changed:
                content = desired.get(relative)
                if content is None:
                    continue
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                with temp.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary[relative] = temp

            for relative in changed:
                target = destination / relative
                if relative in temporary:
                    os.replace(temporary[relative], target)
                elif target.exists():
                    target.unlink()
                touched.append(relative)
        except Exception as exc:
            # Best-effort rollback restores the previous valid snapshot.  If a
            # filesystem error also prevents rollback, surfacing the original
            # exception is still safer than silently continuing.
            for relative in reversed(touched):
                target = destination / relative
                previous = existing.get(relative)
                try:
                    if previous is None:
                        target.unlink(missing_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        rollback = target.with_name(f".{target.name}.{uuid.uuid4().hex}.rollback")
                        rollback.write_bytes(previous)
                        os.replace(rollback, target)
                except OSError:
                    pass
            raise CourseDataError(f"课程数据原子提交失败：{exc}") from exc
        finally:
            for temp in temporary.values():
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass

        # Remove directories left behind by a deleted point/course, deepest first.
        for directory in sorted(destination.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if directory.is_dir() and directory != destination:
                try:
                    directory.rmdir()
                except OSError:
                    pass

    def _write_package(self, course_id: str, course: dict[str, Any], index: dict[str, Any], points: dict[str, dict[str, Any]]) -> None:
        # Start from the full canonical tree.  A CRUD operation on one course
        # must never erase a different course package.
        desired = self._tree_bytes(self.root)
        animation_assets = {
            relative: content
            for relative, content in desired.items()
            if (
                len(relative.parts) == 3
                and relative.parts[0] == course_id
                and relative.parts[1] == "animations"
            )
        }
        for relative in list(desired):
            if relative.parts and relative.parts[0] == course_id:
                del desired[relative]
        desired.update({
            Path(course_id) / "course.json": _json_bytes(course),
            Path(course_id) / "index.json": _json_bytes(index),
        })
        for point_id, point in points.items():
            desired[Path(course_id) / "points" / f"{point_id}.json"] = _json_bytes(point)
        desired.update(animation_assets)
        validation = self._validate_root_from_tree(desired)
        if not validation.ok:
            raise CourseValidationError(validation.errors, validation.warnings)
        self._atomic_sync_tree(self.root, desired)

    # ------------------------------------------------------------------
    # Controlled CRUD API (used by REST and the legacy tool loop)
    # ------------------------------------------------------------------

    def _normalise_cluster(self, cluster: dict[str, Any]) -> dict[str, Any]:
        result = _deepcopy_json(cluster)
        cluster_id = _safe_id(result.get("id"), "cluster.id")
        if not isinstance(result.get("title"), str) or not result["title"].strip():
            raise CourseDataError("cluster.title 不能为空")
        color_index = int(hashlib.sha256(cluster_id.encode("utf-8")).hexdigest(), 16) % len(_DEFAULT_COLORS)
        accent, soft, dark = _DEFAULT_COLORS[color_index]
        result.setdefault("subtitle", "")
        result.setdefault("description", "")
        result.setdefault("accent", accent)
        result.setdefault("soft", soft)
        result.setdefault("dark", dark)
        result.setdefault("polygon", [])
        result.setdefault("labelPos", [2000, 1500])
        return result

    def _normalise_point(self, point: dict[str, Any]) -> dict[str, Any]:
        result = _deepcopy_json(point)
        point_id = _safe_id(result.get("id"), "point.id")
        if not isinstance(result.get("title"), str) or not result["title"].strip():
            raise CourseDataError("point.title 不能为空")
        if not isinstance(result.get("clusterId"), str):
            raise CourseDataError("point.clusterId 不能为空")
        result.setdefault("shortSummary", "")
        result.setdefault("difficulty", "基础")
        result.setdefault("importance", 0.5)
        result.setdefault("keyTerms", [])
        result.setdefault("pos", [0, 0])
        result.setdefault("scale", 1.0)
        result.setdefault("coreIdea", "")
        result.setdefault("principles", [])
        result.setdefault("applications", [])
        result.setdefault("prerequisites", [])
        # Explicitly reference the local variable so static type checkers know
        # that the ID validation above is intentional.
        result["id"] = point_id
        return result

    def _validate_candidate_or_raise(
        self,
        course_id: str,
        course: dict[str, Any],
        index: dict[str, Any],
        points: dict[str, dict[str, Any]],
        *,
        strict_point_ids: Iterable[str] = (),
        require_complete_points: bool = False,
        strict_prerequisites: bool = False,
        allowed_legacy_metadata_mismatches: dict[str, set[str]] | None = None,
    ) -> None:
        validation = self._validate_course_objects(
            # Imported source data contains a few historical metadata and
            # prerequisite inconsistencies. They remain warnings for unrelated
            # writes; the point(s) being created or updated are checked below.
            course_id, course, index, points, strict_details=False
        )
        strict_ids = set(strict_point_ids)
        if strict_ids:
            index_by_id = {
                item.get("id"): item
                for item in index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            for point_id in strict_ids:
                detail = points.get(point_id)
                metadata = index_by_id.get(point_id)
                if detail is None or metadata is None:
                    validation.errors.append(f"课程 {course_id}: 缺少待校验知识点 {point_id}")
                    continue
                for field_name in _POINT_META_FIELDS:
                    if detail.get(field_name) != metadata.get(field_name):
                        if field_name in (allowed_legacy_metadata_mismatches or {}).get(point_id, set()):
                            continue
                        validation.errors.append(
                            f"课程 {course_id}: 新修改的知识点 {point_id} 的 {field_name} 未与 index 同步"
                        )
                prerequisites = detail.get("prerequisites")
                if strict_prerequisites or require_complete_points:
                    if not isinstance(prerequisites, list) or any(not isinstance(item, str) for item in prerequisites):
                        validation.errors.append(
                            f"课程 {course_id}: 知识点 {point_id}.prerequisites 必须是字符串数组"
                        )
                    elif len(set(prerequisites)) != len(prerequisites) or point_id in prerequisites:
                        validation.errors.append(
                            f"课程 {course_id}: 知识点 {point_id}.prerequisites 包含重复或自身引用"
                        )
                    else:
                        for prerequisite in prerequisites:
                            if prerequisite not in index_by_id:
                                validation.errors.append(
                                    f"课程 {course_id}: 知识点 {point_id} 的前置引用不存在：{prerequisite}"
                                )
                if require_complete_points:
                    if not isinstance(detail.get("coreIdea"), str) or not detail["coreIdea"].strip():
                        validation.errors.append(f"课程 {course_id}: 知识点 {point_id} 缺少非空 coreIdea")
                    for content_field in ("principles", "applications"):
                        value = detail.get(content_field)
                        if not isinstance(value, list) or not value or any(
                            not isinstance(item, str) or not item.strip() for item in value
                        ):
                            validation.errors.append(
                                f"课程 {course_id}: 知识点 {point_id}.{content_field} 必须是非空字符串数组"
                            )
        if not validation.ok:
            raise CourseValidationError(validation.errors, validation.warnings)

    def _touch_course(self, course: dict[str, Any]) -> dict[str, Any]:
        course = _deepcopy_json(course)
        course["revision"] = self._revision()
        course["updatedAt"] = self._today()
        return course

    def create_course(self, course: dict[str, Any], index: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            course = _deepcopy_json(course)
            course_id = _safe_id(course.get("id"), "course.id")
            if self._course_dir(course_id, required=False).exists():
                raise CourseDataError(f"课程已存在：{course_id}")
            if not isinstance(course.get("title"), str) or not course["title"].strip():
                raise CourseDataError("course.title 不能为空")
            course.setdefault("schema_version", "1.0")
            course.setdefault("language", "zh-CN")
            course.setdefault("description", "")
            course = self._touch_course(course)
            candidate_index = _deepcopy_json(index) if index is not None else {}
            candidate_index.setdefault("schema_version", "1.0")
            candidate_index["courseId"] = course_id
            candidate_index.setdefault("clusters", [])
            candidate_index.setdefault("points", [])
            self._validate_candidate_or_raise(course_id, course, candidate_index, {})
            self._write_package(course_id, course, candidate_index, {})
            return _deepcopy_json(course)

    def update_course(self, course_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current, index, points = self._load_course_objects(self.root, course_id)
            patch = _deepcopy_json(patch)
            if "id" in patch and patch["id"] != course_id:
                raise CourseDataError("课程 id 不可修改；请创建新课程后迁移内容")
            current.update(patch)
            current["id"] = course_id
            current = self._touch_course(current)
            self._validate_candidate_or_raise(course_id, current, index, points)
            self._write_package(course_id, current, index, points)
            return _deepcopy_json(current)

    def delete_course(self, course_id: str) -> None:
        with self._lock:
            self._course_dir(course_id)
            current = self._tree_bytes(self.root)
            desired = {
                relative: content
                for relative, content in current.items()
                if relative.parts[0] != course_id
            }
            self._atomic_sync_tree(self.root, desired)

    def create_cluster(self, course_id: str, cluster: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            cluster = self._normalise_cluster(cluster)
            clusters = list(index.get("clusters") or [])
            if any(item.get("id") == cluster["id"] for item in clusters if isinstance(item, dict)):
                raise CourseDataError(f"知识簇已存在：{cluster['id']}")
            clusters.append(cluster)
            index = _deepcopy_json(index)
            index["clusters"] = clusters
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(cluster)

    def update_cluster(self, course_id: str, cluster_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cluster_id = _safe_id(cluster_id, "cluster_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            index = _deepcopy_json(index)
            clusters = index.get("clusters") or []
            target = next((item for item in clusters if isinstance(item, dict) and item.get("id") == cluster_id), None)
            if target is None:
                raise CourseNotFoundError(f"知识簇不存在：{cluster_id}")
            if "id" in patch and patch["id"] != cluster_id:
                raise CourseDataError("知识簇 id 不可修改，以免破坏知识点引用")
            target.update(_deepcopy_json(patch))
            target["id"] = cluster_id
            normalised = self._normalise_cluster(target)
            target.clear()
            target.update(normalised)
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(target)

    def delete_cluster(self, course_id: str, cluster_id: str) -> None:
        with self._lock:
            cluster_id = _safe_id(cluster_id, "cluster_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            referring = [
                item.get("id")
                for item in index.get("points") or []
                if isinstance(item, dict) and item.get("clusterId") == cluster_id
            ]
            if referring:
                raise CourseDataError(
                    f"知识簇 {cluster_id} 仍包含 {len(referring)} 个知识点，不能删除"
                )
            clusters = [
                item for item in index.get("clusters") or []
                if not isinstance(item, dict) or item.get("id") != cluster_id
            ]
            if len(clusters) == len(index.get("clusters") or []):
                raise CourseNotFoundError(f"知识簇不存在：{cluster_id}")
            index = _deepcopy_json(index)
            index["clusters"] = clusters
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)

    def create_point(self, course_id: str, point: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            point = self._normalise_point(point)
            point_id = point["id"]
            if point_id in points:
                raise CourseDataError(f"知识点已存在：{point_id}")
            points = dict(points)
            points[point_id] = point
            index = _deepcopy_json(index)
            index["points"] = list(index.get("points") or []) + [
                {field: _deepcopy_json(point[field]) for field in _POINT_META_FIELDS}
            ]
            course = self._touch_course(course)
            self._validate_candidate_or_raise(
                course_id,
                course,
                index,
                points,
                strict_point_ids={point_id},
                require_complete_points=True,
                strict_prerequisites=True,
            )
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(point)

    def update_point(self, course_id: str, point_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            point_id = _safe_id(point_id, "point_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            current = points.get(point_id)
            if current is None:
                raise CourseNotFoundError(f"知识点不存在：{point_id}")
            if "id" in patch and patch["id"] != point_id:
                raise CourseDataError("知识点 id 不可修改，以免破坏前置关系")
            current = _deepcopy_json(current)
            current.update(_deepcopy_json(patch))
            current["id"] = point_id
            current = self._normalise_point(current)
            points = dict(points)
            points[point_id] = current
            index = _deepcopy_json(index)
            for item in index.get("points") or []:
                if isinstance(item, dict) and item.get("id") == point_id:
                    item.update({field: _deepcopy_json(current[field]) for field in _POINT_META_FIELDS})
                    break
            course = self._touch_course(course)
            self._validate_candidate_or_raise(
                course_id,
                course,
                index,
                points,
                strict_point_ids={point_id},
                strict_prerequisites="prerequisites" in patch,
            )
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(current)

    def delete_point(self, course_id: str, point_id: str) -> None:
        with self._lock:
            point_id = _safe_id(point_id, "point_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            if point_id not in points:
                raise CourseNotFoundError(f"知识点不存在：{point_id}")
            points = dict(points)
            del points[point_id]
            # Keep prerequisite references valid by removing the deleted point
            # from the remaining detail files in the same transaction.
            for detail in points.values():
                prerequisites = detail.get("prerequisites")
                if isinstance(prerequisites, list):
                    detail["prerequisites"] = [item for item in prerequisites if item != point_id]
            index = _deepcopy_json(index)
            index["points"] = [
                item for item in index.get("points") or []
                if not isinstance(item, dict) or item.get("id") != point_id
            ]
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)

    # ------------------------------------------------------------------
    # OpenCode staging workspaces
    # ------------------------------------------------------------------

    def _workspace_session_dir(self, conversation_id: str) -> Path:
        return self._within(
            self.workspace_root,
            self.workspace_root / _safe_conversation_id(conversation_id),
        )

    @staticmethod
    def _state_path(session_dir: Path) -> Path:
        return session_dir / ".course-workspace-state"

    @staticmethod
    def _read_state(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    @staticmethod
    def _write_state(path: Path, *, base: str, workspace: str) -> None:
        path.write_text(
            json.dumps({"base": base, "workspace": workspace}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _copy_canonical_to_workspace(self, workspace: Path) -> None:
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.parent.mkdir(parents=True, exist_ok=True)
        # copytree handles an empty canonical root as well.
        shutil.copytree(self.root, workspace)

    def prepare_workspace(self, conversation_id: str) -> CourseWorkspace:
        """Return a conflict-aware staged copy for one OpenCode conversation."""

        with self._lock:
            session_dir = self._workspace_session_dir(conversation_id)
            workspace = session_dir / "courses"
            state_path = self._state_path(session_dir)
            current = self._fingerprint(self.root)
            state = self._read_state(state_path)
            if workspace.is_dir() and state:
                workspace_fingerprint = self._fingerprint(workspace)
                if state.get("base") == current:
                    return CourseWorkspace(conversation_id, workspace, current)
                if state.get("workspace") != workspace_fingerprint:
                    raise CourseConflictError(
                        "课程数据已被其他会话更新，当前暂存工作区仍有未提交修改；请先完成或丢弃该会话。"
                    )
            self._copy_canonical_to_workspace(workspace)
            workspace_fingerprint = self._fingerprint(workspace)
            self._write_state(state_path, base=current, workspace=workspace_fingerprint)
            return CourseWorkspace(conversation_id, workspace, current)

    def prepare_readonly_workspace(self, conversation_id: str) -> CourseWorkspace:
        """Create a disposable course snapshot for a read-only Chat turn.

        OpenCode still needs ordinary files so it can search and read course
        content.  Chat sessions therefore receive a private snapshot, but that
        snapshot is never eligible for ``commit_workspace``.  It is refreshed
        before every turn and restored afterwards, so even an unexpected write
        cannot leak into the canonical course catalog or a later Chat turn.
        """

        with self._lock:
            scoped_id = f"chat-{_safe_conversation_id(conversation_id)}"[:80]
            session_dir = self._workspace_session_dir(scoped_id)
            workspace = session_dir / "courses"
            current = self._fingerprint(self.root)
            self._copy_canonical_to_workspace(workspace)
            return CourseWorkspace(scoped_id, workspace, current)

    def restore_readonly_workspace(self, workspace: CourseWorkspace) -> None:
        """Discard all Chat-session file changes and restore its snapshot."""

        with self._lock:
            session_dir = self._workspace_session_dir(workspace.conversation_id)
            expected_path = (session_dir / "courses").resolve()
            if workspace.path.resolve() != expected_path:
                raise CourseDataError("无效的只读课程工作区")
            self._copy_canonical_to_workspace(workspace.path)

    def commit_workspace(self, workspace: CourseWorkspace) -> dict[str, Any]:
        """Validate a staged OpenCode tree and atomically promote its changes."""

        with self._lock:
            session_dir = self._workspace_session_dir(workspace.conversation_id)
            expected_path = (session_dir / "courses").resolve()
            if workspace.path.resolve() != expected_path:
                raise CourseDataError("无效的课程暂存工作区")
            if self._fingerprint(self.root) != workspace.base_fingerprint:
                raise CourseConflictError("课程数据已被其他会话更新，请重新开始本次修改")

            # ``strict_details=False`` deliberately accepts the handful of
            # legacy source warnings while still rejecting malformed JSON,
            # dangling files, unsafe paths, and invalid forest metadata.
            validation = self._validate_root(workspace.path, strict_details=False)
            if not validation.ok:
                raise CourseValidationError(validation.errors, validation.warnings)

            changed_validation = self._validate_workspace_changes(workspace.path)
            if not changed_validation.ok:
                raise CourseValidationError(
                    changed_validation.errors,
                    list(dict.fromkeys(validation.warnings + changed_validation.warnings)),
                )
            validation.warnings = list(
                dict.fromkeys(validation.warnings + changed_validation.warnings)
            )

            before = self._tree_bytes(self.root)
            desired = self._tree_bytes(workspace.path)
            changed_before_revision = sorted(
                [
                    path for path in set(before) | set(desired)
                    if before.get(path) != desired.get(path)
                ],
                key=lambda item: item.as_posix(),
            )
            if not changed_before_revision:
                return {
                    "changed_paths": [],
                    "course_ids": [],
                    "revision": self._fingerprint_from_tree(before),
                    "warnings": validation.warnings,
                }

            changed_course_ids = sorted({path.parts[0] for path in changed_before_revision})
            # Revision metadata belongs to every changed course, including a
            # course whose only modification was a point detail file.
            for course_id in changed_course_ids:
                course_path = Path(course_id) / "course.json"
                if course_path not in desired:
                    continue  # deleted course
                try:
                    metadata = json.loads(desired[course_path].decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise CourseDataError(f"课程 {course_id} 的 course.json 无法解析") from exc
                if not isinstance(metadata, dict):
                    raise CourseDataError(f"课程 {course_id} 的 course.json 必须是对象")
                metadata["revision"] = self._revision()
                metadata["updatedAt"] = self._today()
                desired[course_path] = _json_bytes(metadata)

            final_validation = self._validate_root_from_tree(desired)
            if not final_validation.ok:
                raise CourseValidationError(final_validation.errors, final_validation.warnings)

            self._atomic_sync_tree(self.root, desired)
            # Reset the staged copy to exactly what was committed so future
            # turns start from a clean, conflict-free snapshot.
            self._copy_canonical_to_workspace(workspace.path)
            canonical_fingerprint = self._fingerprint(self.root)
            self._write_state(
                self._state_path(session_dir),
                base=canonical_fingerprint,
                workspace=self._fingerprint(workspace.path),
            )
            final_changed_paths = sorted(
                [
                    path for path in set(before) | set(desired)
                    if before.get(path) != desired.get(path)
                ],
                key=lambda item: item.as_posix(),
            )
            return {
                "changed_paths": [path.as_posix() for path in final_changed_paths],
                "course_ids": changed_course_ids,
                "revision": canonical_fingerprint,
                "warnings": final_validation.warnings,
            }

    def _validate_root_from_tree(self, tree: dict[Path, bytes]) -> ValidationResult:
        """Validate serialized candidate bytes without exposing a temp package."""

        root = self.workspace_root / f".validate-{uuid.uuid4().hex}"
        try:
            self._atomic_sync_tree(root, tree)
            return self._validate_root(root, strict_details=False)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def _validate_workspace_changes(self, workspace_root: Path) -> ValidationResult:
        """Apply stricter rules only to points an agent actually changed.

        The imported baseline has a small, known set of old index/detail and
        prerequisite inconsistencies.  Treating those as hard errors would make
        a harmless edit to a course title impossible.  Conversely, allowing a
        newly authored point to introduce the same inconsistencies would defeat
        the purpose of the validation layer.  This comparison preserves the
        baseline while requiring changed/new points to be internally sound.
        """

        result = ValidationResult()
        before_ids = set(self._course_ids_in(self.root))
        after_ids = set(self._course_ids_in(workspace_root))
        for course_id in sorted(after_ids):
            after_course, after_index, after_points = self._load_course_objects(
                workspace_root, course_id
            )
            before_index: dict[str, Any] = {"points": []}
            before_points: dict[str, dict[str, Any]] = {}
            if course_id in before_ids:
                _, before_index, before_points = self._load_course_objects(self.root, course_id)

            before_meta = {
                item.get("id"): item
                for item in before_index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            after_meta = {
                item.get("id"): item
                for item in after_index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            changed_ids: set[str] = set()
            for point_id in set(before_meta) | set(after_meta):
                if before_meta.get(point_id) != after_meta.get(point_id):
                    changed_ids.add(point_id)
            for point_id in set(before_points) | set(after_points):
                if before_points.get(point_id) != after_points.get(point_id):
                    changed_ids.add(point_id)

            for point_id in sorted(changed_ids & set(after_points)):
                is_new = point_id not in before_points
                prerequisites_changed = (
                    is_new
                    or before_points.get(point_id, {}).get("prerequisites")
                    != after_points[point_id].get("prerequisites")
                )
                legacy_mismatches: set[str] = set()
                if not is_new and point_id in before_meta and point_id in after_meta:
                    for field_name in _POINT_META_FIELDS:
                        # A mismatch is tolerated only when this exact legacy
                        # discrepancy was already present and the agent did not
                        # alter either copy of that field.
                        if (
                            before_points[point_id].get(field_name)
                            != before_meta[point_id].get(field_name)
                            and after_points[point_id].get(field_name)
                            == before_points[point_id].get(field_name)
                            and after_meta[point_id].get(field_name)
                            == before_meta[point_id].get(field_name)
                        ):
                            legacy_mismatches.add(field_name)
                try:
                    self._validate_candidate_or_raise(
                        course_id,
                        after_course,
                        after_index,
                        after_points,
                        strict_point_ids={point_id},
                        require_complete_points=is_new,
                        strict_prerequisites=prerequisites_changed,
                        allowed_legacy_metadata_mismatches={point_id: legacy_mismatches},
                    )
                except CourseValidationError as exc:
                    result.errors.extend(exc.errors)
                    result.warnings.extend(exc.warnings)

            removed_ids = set(before_points) - set(after_points)
            if removed_ids:
                for point_id, detail in after_points.items():
                    prerequisites = detail.get("prerequisites")
                    if isinstance(prerequisites, list):
                        for removed in sorted(removed_ids & set(prerequisites)):
                            result.errors.append(
                                f"课程 {course_id}: 删除知识点 {removed} 前必须从 {point_id}.prerequisites 移除引用"
                            )
        # Avoid repeating the same legacy warning once per changed point.
        result.warnings = list(dict.fromkeys(result.warnings))
        result.errors = list(dict.fromkeys(result.errors))
        return result


_store: CourseStore | None = None
_store_lock = threading.Lock()


def get_course_store() -> CourseStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = CourseStore()
        return _store
