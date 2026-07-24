"""Backend-owned review resources for the course creation pipeline.

The API holds the same per-conversation activity lease for an OpenCode turn
and for a review submission, so this store never races a backend-started agent
writer. Review CAS plus the durable journal still detects and preserves bytes
written independently of Course Studio instead of rolling them back.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import uuid
from typing import Any, Iterator

from ...config import PROJECT_ROOT, settings
from ..locking import exclusive_file_lock, FileLockError


_COURSE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_GRAPH_ROLES = {"trunk", "branch", "leaf"}
_REVIEW_KINDS = {
    "knowledge-points": "G2_IDENTITY_REVIEW",
    "knowledge-graph": "G6_GRAPH_REVIEW",
}
_REQUEST_SCHEMA = "course-review-request/1.0"
_RESOURCE_SCHEMA = "course-review-resource/1.0"
_APPROVAL_SCHEMA = "course-review-approval/1.0"
_TRANSACTION_SCHEMA = "course-review-transaction/1.0"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_ISO_UTC = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$"
)
RESUME_CLAIM_HEARTBEAT_SECONDS = 30.0
RESUME_CLAIM_LEASE_SECONDS = 120.0


class CourseReviewError(RuntimeError):
    pass


class CourseReviewNotFoundError(CourseReviewError):
    pass


class CourseReviewConflictError(CourseReviewError):
    pass


class CourseReviewValidationError(CourseReviewError):
    def __init__(self, message: str, *, details: list[str] | None = None):
        super().__init__(message)
        self.details = details or []


class CourseReviewUnsafePathError(CourseReviewValidationError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _is_iso_utc(value: Any) -> bool:
    if not isinstance(value, str) or not _ISO_UTC.fullmatch(value):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == UTC.utcoffset(parsed)


def _parse_iso_utc(value: Any) -> datetime | None:
    if not _is_iso_utc(value):
        return None
    return datetime.fromisoformat(str(value)[:-1] + "+00:00")


def _resume_claim_lease() -> timedelta:
    # Long-running turns renew this short lease in the background. Keeping the
    # lease independent of the terminal timeout lets another process recover a
    # claim promptly after a crash instead of waiting for the full model budget.
    return timedelta(seconds=RESUME_CLAIM_LEASE_SECONDS)


def is_strict_g2_successor(
    resume_review: dict[str, Any] | None,
    pending_review: dict[str, Any] | None,
) -> bool:
    if resume_review is None or pending_review is None:
        return False
    return (
        resume_review.get("kind") == "knowledge-points"
        and resume_review.get("gate") == "G2_IDENTITY_REVIEW"
        and pending_review.get("kind") == "knowledge-graph"
        and pending_review.get("gate") == "G6_GRAPH_REVIEW"
        and pending_review.get("status") == "pending"
        and pending_review.get("id") != resume_review.get("id")
        and pending_review.get("conversation_id")
        == resume_review.get("conversation_id")
        and pending_review.get("course_id") == resume_review.get("course_id")
    )


def _safe_conversation_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(value))
    return cleaned[:80] or "default"


def _hash_json(value: Any, *, sort_keys: bool = False) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=sort_keys,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _assert_safe_path_chain(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for index, part in enumerate(parts):
        current /= part
        if not os.path.lexists(current):
            continue
        if current.is_symlink():
            raise CourseReviewUnsafePathError(f"审核路径不允许符号链接：{current}")
        if index < len(parts) - 1 and not current.is_dir():
            raise CourseReviewUnsafePathError(f"审核路径祖先不是目录：{current}")
    return absolute


def _canonical_trusted_root(path: Path) -> Path:
    """Canonicalize an operator-selected root before checking paths beneath it."""
    absolute = Path(os.path.abspath(path))
    if os.path.lexists(absolute) and absolute.is_symlink():
        raise CourseReviewUnsafePathError(f"审核根路径不允许符号链接：{absolute}")
    return _assert_safe_path_chain(absolute.resolve())


def _identity_payload(points: list[dict[str, Any]]) -> list[list[str]]:
    identity: list[list[str]] = []
    seen: set[str] = set()
    for index, point in enumerate(points):
        raw_point_id = point.get("id")
        point_id = raw_point_id if isinstance(raw_point_id, str) else ""
        title = str(point.get("title") or "").strip()
        if not _COURSE_ID.fullmatch(point_id) or point_id in seen:
            raise CourseReviewValidationError(
                f"第 {index + 1} 个知识点 ID 缺失、非法或重复"
            )
        if not title:
            raise CourseReviewValidationError(f"知识点 {point_id} 缺少标题")
        seen.add(point_id)
        identity.append([point_id, title])
    if not identity:
        raise CourseReviewValidationError("知识点清单不能为空")
    return identity


def _edge_payload(points: list[dict[str, Any]]) -> list[list[str]]:
    point_ids = {str(point.get("id") or "") for point in points}
    edges: list[list[str]] = []
    for point in points:
        dependent_id = str(point.get("id") or "")
        prerequisites = point.get("prerequisites")
        if not isinstance(prerequisites, list):
            raise CourseReviewValidationError(
                f"知识点 {dependent_id} 的 prerequisites 必须是数组"
            )
        seen: set[str] = set()
        for value in prerequisites:
            prerequisite_id = str(value or "")
            if (
                prerequisite_id not in point_ids
                or prerequisite_id == dependent_id
                or prerequisite_id in seen
            ):
                raise CourseReviewValidationError(
                    f"知识点 {dependent_id} 包含非法、重复、自引用或悬空的 prerequisite"
                )
            seen.add(prerequisite_id)
            edges.append([dependent_id, prerequisite_id])
    return sorted(edges, key=lambda edge: (edge[0], edge[1]))


def _cluster_payload(
    points: list[dict[str, Any]],
    cluster_ids: set[str],
) -> list[dict[str, Any]]:
    """Validate and normalize the ordered cluster assignment contract."""

    assignments: list[dict[str, Any]] = []
    for point in points:
        point_id = str(point.get("id") or "")
        raw_cluster_ids = point.get("clusterIds")
        if not isinstance(raw_cluster_ids, list) or not raw_cluster_ids:
            raise CourseReviewValidationError(
                f"知识点 {point_id} 的 clusterIds 必须是非空数组"
            )
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_cluster_id in raw_cluster_ids:
            cluster_id = str(raw_cluster_id or "")
            if cluster_id not in cluster_ids or cluster_id in seen:
                raise CourseReviewValidationError(
                    f"知识点 {point_id} 包含非法、重复或悬空的 clusterId"
                )
            seen.add(cluster_id)
            normalized.append(cluster_id)
        related = point.get("related")
        if not isinstance(related, list):
            raise CourseReviewValidationError(
                f"知识点 {point_id} 的 related 必须是数组"
            )
        role = str(point.get("role") or "").strip()
        if role not in _GRAPH_ROLES:
            raise CourseReviewValidationError(
                f"知识点 {point_id} 的 role 必须是 trunk/branch/leaf"
            )
        assignments.append({
            "id": point_id,
            "clusterIds": normalized,
            "role": role,
            "related": deepcopy(related),
        })
    return assignments


def _graph_clusters(graph: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    clusters = graph.get("clusters")
    if not isinstance(clusters, list) or not clusters:
        raise CourseReviewValidationError("graph.clusters 必须是非空对象数组")
    normalized: list[dict[str, Any]] = []
    cluster_ids: set[str] = set()
    for index, cluster in enumerate(clusters):
        if not isinstance(cluster, dict):
            raise CourseReviewValidationError(
                f"graph.clusters[{index}] 必须是对象"
            )
        cluster_id = str(cluster.get("id") or "")
        if not _COURSE_ID.fullmatch(cluster_id) or cluster_id in cluster_ids:
            raise CourseReviewValidationError(
                f"graph.clusters[{index}].id 缺失、非法或重复"
            )
        if not str(cluster.get("title") or "").strip():
            raise CourseReviewValidationError(
                f"graph.clusters[{index}].title 不能为空"
            )
        cluster_ids.add(cluster_id)
        normalized.append(deepcopy(cluster))
    return normalized, cluster_ids


def _normalized_review_audit(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise CourseReviewValidationError("refinedPrerequisiteEdges 必须是数组")
    normalized: list[dict[str, str]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {"op", "from", "to", "reason"}:
            raise CourseReviewValidationError(
                f"refinedPrerequisiteEdges[{index}] 必须严格包含 op/from/to/reason"
            )
        normalized.append({
            "op": str(item.get("op") or "").strip(),
            "from": str(item.get("from") or "").strip(),
            "to": str(item.get("to") or "").strip(),
            "reason": str(item.get("reason") or "").strip(),
        })
    return normalized


def _review_audit_sha256(graph: dict[str, Any]) -> str:
    generation = graph.get("generation")
    if not isinstance(generation, dict):
        raise CourseReviewValidationError("graph.generation 必须是对象")
    broken_cycle_edges = generation.get("brokenCycleEdges")
    if not isinstance(broken_cycle_edges, list) or not all(
        isinstance(item, dict) for item in broken_cycle_edges
    ):
        raise CourseReviewValidationError("brokenCycleEdges 必须是对象数组")
    return _hash_json(
        {
            "refinedPrerequisiteEdges": _normalized_review_audit(
                generation.get("refinedPrerequisiteEdges")
            ),
            "brokenCycleEdges": deepcopy(broken_cycle_edges),
        },
        sort_keys=True,
    )


def _valid_signed_operations(kind: str, value: Any) -> bool:
    if not isinstance(value, list) or len(value) > 500:
        return False
    for operation in value:
        if not isinstance(operation, dict):
            return False
        op = operation.get("op")
        if kind == "knowledge-points":
            if op == "delete":
                if (
                    set(operation) != {"op", "point_id"}
                    or not _COURSE_ID.fullmatch(str(operation.get("point_id") or ""))
                ):
                    return False
            elif op == "add":
                point = operation.get("point")
                if (
                    set(operation) != {"op", "point"}
                    or not isinstance(point, dict)
                    or set(point) != {"id", "title"}
                    or not _COURSE_ID.fullmatch(str(point.get("id") or ""))
                    or not str(point.get("title") or "").strip()
                ):
                    return False
            else:
                return False
            continue

        if kind != "knowledge-graph":
            return False
        if op == "set-clusters":
            cluster_ids = operation.get("cluster_ids")
            if (
                set(operation) != {"op", "point_id", "cluster_ids"}
                or not _COURSE_ID.fullmatch(str(operation.get("point_id") or ""))
                or not isinstance(cluster_ids, list)
                or not cluster_ids
                or len(cluster_ids) != len(set(map(str, cluster_ids)))
                or not all(
                    _COURSE_ID.fullmatch(str(cluster_id or ""))
                    for cluster_id in cluster_ids
                )
            ):
                return False
            continue
        if op in {"add-prerequisite", "remove-prerequisite"}:
            dependent_key = "point_id"
        elif op in {"add", "remove"}:
            dependent_key = "dependent_id"
        else:
            return False
        if (
            set(operation)
            != {"op", dependent_key, "prerequisite_id", "reason"}
            or not _COURSE_ID.fullmatch(str(operation.get(dependent_key) or ""))
            or not _COURSE_ID.fullmatch(
                str(operation.get("prerequisite_id") or "")
            )
            or not str(operation.get("reason") or "").strip()
        ):
            return False
    return True


def _read_json(path: Path, label: str) -> dict[str, Any]:
    path = _assert_safe_path_chain(path)
    if not path.is_file():
        raise CourseReviewValidationError(f"缺少或拒绝读取不安全的{label}：{path}")
    return _parse_json_bytes(path.read_bytes(), label, path)


def _parse_json_bytes(content: bytes, label: str, path: Path) -> dict[str, Any]:
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CourseReviewValidationError(f"{label}不是有效 JSON：{path}") from exc
    if not isinstance(value, dict):
        raise CourseReviewValidationError(f"{label}必须是 JSON 对象：{path}")
    return value


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    path = _assert_safe_path_chain(path)
    if not os.path.lexists(path):
        return None
    try:
        return _read_json(path, "审核文件")
    except CourseReviewUnsafePathError:
        raise
    except CourseReviewValidationError:
        return None


def _write_json_atomic(path: Path, value: dict[str, Any]) -> bytes:
    path = _assert_safe_path_chain(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _assert_safe_path_chain(path.parent)
    if os.path.lexists(path) and not path.is_file():
        raise CourseReviewUnsafePathError(f"审核文件不是普通文件：{path}")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    content = _json_bytes(value)
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        _fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
    return content


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _restore_bytes(path: Path, original: bytes | None) -> None:
    path = _assert_safe_path_chain(path)
    if original is None:
        if path.exists():
            path.unlink()
            _fsync_directory(path.parent)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.rollback")
    try:
        with temporary.open("xb") as handle:
            handle.write(original)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        _fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def _capture_bytes(path: Path) -> bytes | None:
    path = _assert_safe_path_chain(path)
    if not os.path.lexists(path):
        return None
    if not path.is_file():
        raise CourseReviewValidationError(f"审核事务拒绝非普通文件：{path}")
    return path.read_bytes()


def _write_json_cas(
    path: Path,
    value: dict[str, Any],
    *,
    expected: bytes | None,
) -> bytes:
    if _capture_bytes(path) != expected:
        raise CourseReviewConflictError(
            "审核源数据在提交期间发生变化，请刷新后重新确认"
        )
    return _write_json_atomic(path, value)


def _unlink_cas(path: Path, *, expected: bytes | None) -> None:
    if _capture_bytes(path) != expected:
        raise CourseReviewConflictError(
            "审核源数据在提交期间发生变化，请刷新后重新确认"
        )
    if expected is not None:
        path.unlink()
        _fsync_directory(path.parent)


def _rollback_owned_writes(
    originals: dict[Path, bytes | None],
    writes: dict[Path, bytes | None],
) -> list[str]:
    errors: list[str] = []
    for path in reversed(list(writes)):
        if path not in originals:
            continue
        try:
            # A different current value belongs to a concurrent writer. Never
            # replace it with this transaction's stale pre-submit snapshot.
            if _capture_bytes(path) == writes[path]:
                _restore_bytes(path, originals[path])
        except Exception as exc:
            errors.append(f"{path}: {exc}")
    return errors


def _default_summary(title: str) -> str:
    subject = title.strip()[:36]
    summary = (
        f"{subject}是本课程中需要独立理解、练习和考核的知识点，"
        "后续内容生成将补充其定义、机制、边界与实际应用。"
    )
    if len(summary) > 100:
        summary = summary[:99].rstrip("，。") + "。"
    return summary


def _cycle_path(point_ids: list[str], edges: set[tuple[str, str]]) -> list[str] | None:
    adjacency = {point_id: [] for point_id in point_ids}
    for dependent_id, prerequisite_id in edges:
        adjacency[dependent_id].append(prerequisite_id)
    state: dict[str, int] = {}
    stack: list[str] = []
    position: dict[str, int] = {}

    def visit(point_id: str) -> list[str] | None:
        state[point_id] = 1
        position[point_id] = len(stack)
        stack.append(point_id)
        for prerequisite_id in adjacency[point_id]:
            if state.get(prerequisite_id, 0) == 0:
                cycle = visit(prerequisite_id)
                if cycle:
                    return cycle
            elif state.get(prerequisite_id) == 1:
                start = position[prerequisite_id]
                return stack[start:] + [prerequisite_id]
        stack.pop()
        position.pop(point_id, None)
        state[point_id] = 2
        return None

    for point_id in point_ids:
        if state.get(point_id, 0) == 0:
            cycle = visit(point_id)
            if cycle:
                return cycle
    return None


class CourseReviewStore:
    def __init__(
        self,
        workspace_root: Path | None = None,
        project_root: Path | None = None,
    ):
        workspace_path = _canonical_trusted_root(
            Path(workspace_root or settings.course_agent_workspace_dir)
        )
        project_path = _canonical_trusted_root(Path(project_root or PROJECT_ROOT))
        self.workspace_root = workspace_path
        self.project_root = project_path
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        _assert_safe_path_chain(self.workspace_root)
        self._lock = threading.RLock()
        with self._review_transaction_lock(recover=False):
            self._recover_review_transactions()

    @contextmanager
    def _review_transaction_lock(self, *, recover: bool = True) -> Iterator[None]:
        lock_path = (
            self.workspace_root.parent
            / f".{self.workspace_root.name}.review-transactions.lock"
        )
        try:
            with exclusive_file_lock(lock_path):
                if recover:
                    self._recover_review_transactions()
                yield
        except FileLockError as exc:
            raise CourseReviewError(f"无法获取审核事务锁：{exc}") from exc

    def _within(self, root: Path, target: Path) -> Path:
        root = _assert_safe_path_chain(root)
        absolute = _assert_safe_path_chain(target)
        try:
            absolute.relative_to(root)
        except ValueError as exc:
            raise CourseReviewValidationError(f"审核路径越界：{target}") from exc
        return absolute

    def _session_root(self, conversation_id: str) -> Path:
        return self._within(
            self.workspace_root,
            self.workspace_root / _safe_conversation_id(conversation_id),
        )

    @staticmethod
    def _approval_path(session_root: Path, course_id: str, kind: str) -> Path:
        return session_root / ".course-review-approvals" / course_id / f"{kind}.json"

    @staticmethod
    def _resource_path(session_root: Path, course_id: str, kind: str) -> Path:
        return session_root / ".course-reviews" / course_id / f"{kind}.json"

    @staticmethod
    def _transaction_path(session_root: Path, course_id: str, kind: str) -> Path:
        return (
            session_root
            / ".course-review-transactions"
            / course_id
            / f"{kind}.json"
        )

    def _recover_review_transactions(self) -> None:
        """Recover prepared review writes left by a stopped backend process."""

        if not self.workspace_root.is_dir():
            return
        for session_root in sorted(self.workspace_root.iterdir()):
            _assert_safe_path_chain(session_root)
            if not session_root.is_dir():
                continue
            transaction_root = session_root / ".course-review-transactions"
            _assert_safe_path_chain(transaction_root)
            if not transaction_root.exists():
                continue
            if not transaction_root.is_dir():
                raise CourseReviewUnsafePathError(
                    "审核事务路径不是目录"
                )
            for course_root in sorted(transaction_root.iterdir()):
                _assert_safe_path_chain(course_root)
                if (
                    not course_root.is_dir()
                    or _COURSE_ID.fullmatch(course_root.name) is None
                ):
                    raise CourseReviewUnsafePathError(
                        "审核事务包含非法课程目录"
                    )
                for kind in _REVIEW_KINDS:
                    journal_path = course_root / f"{kind}.json"
                    if os.path.lexists(journal_path):
                        self._recover_review_transaction(journal_path)

    def _read_review_transaction(self, journal_path: Path) -> dict[str, Any]:
        journal_path = self._within(self.workspace_root, journal_path)
        journal = _read_json(journal_path, "审核事务日志")
        session_root = journal_path.parent.parent.parent
        if (
            journal.get("schema_version") != _TRANSACTION_SCHEMA
            or journal.get("state") not in {"prepared", "committed"}
            or not isinstance(journal.get("transaction_id"), str)
            or re.fullmatch(r"[0-9a-f]{32}", journal["transaction_id"]) is None
            or journal.get("kind") not in _REVIEW_KINDS
            or _COURSE_ID.fullmatch(str(journal.get("course_id") or "")) is None
            or not isinstance(journal.get("originals"), dict)
            or not isinstance(journal.get("planned"), dict)
            or not set(journal["planned"]).issubset(journal["originals"])
            or journal.get("course_id") != journal_path.parent.name
            or journal.get("kind") != journal_path.stem
            or journal.get("conversation_id") != session_root.name
        ):
            raise CourseReviewValidationError("审核事务日志格式无效")
        course_id = str(journal["course_id"])
        kind = str(journal["kind"])
        paths = self._pipeline_paths(session_root, course_id)
        expected_paths = (
            {
                paths["index"],
                paths["manifest"],
                self._approval_path(session_root, course_id, "knowledge-points"),
                self._approval_path(session_root, course_id, "knowledge-graph"),
                self._resource_path(session_root, course_id, "knowledge-points"),
            }
            if kind == "knowledge-points"
            else {
                paths["graph"],
                self._approval_path(session_root, course_id, "knowledge-graph"),
                self._resource_path(session_root, course_id, "knowledge-graph"),
            }
        )
        expected_relatives = {
            self._within(session_root, path).relative_to(session_root).as_posix()
            for path in expected_paths
        }
        if set(journal["originals"]) != expected_relatives:
            raise CourseReviewValidationError(
                "审核事务日志的写入范围与审核类型不匹配"
            )
        return journal

    @staticmethod
    def _decode_transaction_original(
        record: Any,
        relative: str,
    ) -> bytes | None:
        if not isinstance(record, dict) or set(record) != {
            "present",
            "sha256",
            "content_base64",
        }:
            raise CourseReviewValidationError(
                f"审核事务原始快照格式无效：{relative}"
            )
        present = record.get("present")
        expected_hash = record.get("sha256")
        encoded = record.get("content_base64")
        if present is False and expected_hash is None and encoded is None:
            return None
        if (
            present is not True
            or not isinstance(expected_hash, str)
            or _SHA256.fullmatch(expected_hash) is None
            or not isinstance(encoded, str)
        ):
            raise CourseReviewValidationError(
                f"审核事务原始快照字段无效：{relative}"
            )
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise CourseReviewValidationError(
                f"审核事务原始快照编码无效：{relative}"
            ) from exc
        if hashlib.sha256(content).hexdigest() != expected_hash:
            raise CourseReviewValidationError(
                f"审核事务原始快照哈希不匹配：{relative}"
            )
        return content

    @staticmethod
    def _transaction_record_matches(
        content: bytes | None,
        record: Any,
    ) -> bool:
        if not isinstance(record, dict) or set(record) != {"present", "sha256"}:
            return False
        if record.get("present") is False:
            return content is None and record.get("sha256") is None
        return bool(
            record.get("present") is True
            and isinstance(record.get("sha256"), str)
            and _SHA256.fullmatch(record["sha256"])
            and content is not None
            and hashlib.sha256(content).hexdigest() == record["sha256"]
        )

    def _cleanup_review_transaction(self, journal_path: Path) -> None:
        journal_path.unlink(missing_ok=True)
        _fsync_directory(journal_path.parent)
        for directory in (journal_path.parent, journal_path.parent.parent):
            try:
                directory.rmdir()
            except OSError:
                break

    def _recover_review_transaction(self, journal_path: Path) -> None:
        journal = self._read_review_transaction(journal_path)
        if journal["state"] == "committed":
            self._cleanup_review_transaction(journal_path)
            return

        session_root = journal_path.parent.parent.parent
        session_root = self._within(self.workspace_root, session_root)
        originals = journal["originals"]
        planned = journal["planned"]
        for relative, record in reversed(list(originals.items())):
            if not isinstance(relative, str):
                raise CourseReviewValidationError("审核事务路径必须是字符串")
            relative_path = Path(relative)
            if (
                relative_path.is_absolute()
                or relative_path.as_posix() != relative
                or relative in {"", "."}
            ):
                raise CourseReviewValidationError("审核事务包含非法相对路径")
            target = self._within(session_root, session_root / relative_path)
            original = self._decode_transaction_original(record, relative)
            current = _capture_bytes(target)
            if current == original:
                continue
            # A planned value is owned by this interrupted transaction and can
            # be restored. Any other bytes belong to a concurrent external
            # writer; preserve them and let the next review refresh detect the
            # changed artifact instead of overwriting that writer.
            if self._transaction_record_matches(current, planned.get(relative)):
                _restore_bytes(target, original)
        self._cleanup_review_transaction(journal_path)

    def _begin_review_transaction(
        self,
        session_root: Path,
        resource: dict[str, Any],
        originals: dict[Path, bytes | None],
    ) -> Path:
        course_id = str(resource["course_id"])
        kind = str(resource["kind"])
        journal_path = self._transaction_path(session_root, course_id, kind)
        if os.path.lexists(journal_path):
            self._recover_review_transaction(journal_path)
        encoded_originals: dict[str, dict[str, Any]] = {}
        for raw_path, original in originals.items():
            path = self._within(session_root, raw_path)
            if _capture_bytes(path) != original:
                raise CourseReviewConflictError(
                    "审核源数据在事务建立前发生变化，请刷新后重新确认"
                )
            relative = path.relative_to(session_root).as_posix()
            encoded_originals[relative] = {
                "present": original is not None,
                "sha256": (
                    hashlib.sha256(original).hexdigest()
                    if original is not None
                    else None
                ),
                "content_base64": (
                    base64.b64encode(original).decode("ascii")
                    if original is not None
                    else None
                ),
            }
        _write_json_atomic(
            journal_path,
            {
                "schema_version": _TRANSACTION_SCHEMA,
                "state": "prepared",
                "transaction_id": uuid.uuid4().hex,
                "review_id": resource["id"],
                "conversation_id": resource["conversation_id"],
                "course_id": course_id,
                "kind": kind,
                "created_at": _now(),
                "originals": encoded_originals,
                "planned": {},
            },
        )
        return journal_path

    def _record_review_transaction_write(
        self,
        journal_path: Path,
        target: Path,
        content: bytes | None,
    ) -> None:
        journal = self._read_review_transaction(journal_path)
        if journal["state"] != "prepared":
            raise CourseReviewConflictError("审核事务已经结束")
        session_root = journal_path.parent.parent.parent
        target = self._within(session_root, target)
        relative = target.relative_to(session_root).as_posix()
        if relative not in journal["originals"]:
            raise CourseReviewValidationError(
                f"审核事务拒绝未声明的写入：{relative}"
            )
        journal["planned"][relative] = {
            "present": content is not None,
            "sha256": (
                hashlib.sha256(content).hexdigest()
                if content is not None
                else None
            ),
        }
        _write_json_atomic(journal_path, journal)

    def _write_review_transaction_json_cas(
        self,
        journal_path: Path,
        target: Path,
        value: dict[str, Any],
        *,
        expected: bytes | None,
    ) -> bytes:
        content = _json_bytes(value)
        self._record_review_transaction_write(journal_path, target, content)
        return _write_json_cas(target, value, expected=expected)

    def _unlink_review_transaction_cas(
        self,
        journal_path: Path,
        target: Path,
        *,
        expected: bytes | None,
    ) -> None:
        self._record_review_transaction_write(journal_path, target, None)
        _unlink_cas(target, expected=expected)

    def _commit_review_transaction(self, journal_path: Path) -> None:
        journal = self._read_review_transaction(journal_path)
        if journal["state"] != "prepared":
            raise CourseReviewConflictError("审核事务已经结束")
        journal["state"] = "committed"
        journal["committed_at"] = _now()
        _write_json_atomic(journal_path, journal)
        self._cleanup_review_transaction(journal_path)

    @staticmethod
    def _pipeline_paths(session_root: Path, course_id: str) -> dict[str, Path]:
        course_root = session_root / "pipeline" / course_id
        content_root = course_root / "course-content"
        return {
            "course_root": course_root,
            "content_root": content_root,
            "course": content_root / "src" / "data" / "course.json",
            "index": content_root / "src" / "data" / "index.json",
            "manifest": content_root / "generation" / "manifest.json",
            "points": content_root / "src" / "data" / "points",
            "graph": course_root / "clustered-graph.json",
        }

    @staticmethod
    def _required_document(path: Path, label: str) -> tuple[bytes, dict[str, Any]]:
        content = _capture_bytes(path)
        if content is None:
            raise CourseReviewValidationError(f"缺少{label}：{path}")
        return content, _parse_json_bytes(content, label, path)

    def _knowledge_source(
        self, session_root: Path, course_id: str
    ) -> tuple[dict[str, Any], dict[Path, bytes]]:
        paths = self._pipeline_paths(session_root, course_id)
        documents: dict[str, Any] = {}
        originals: dict[Path, bytes] = {}
        for key, label in (
            ("course", "课程元数据"),
            ("index", "课程索引"),
            ("manifest", "生成清单"),
        ):
            content, document = self._required_document(paths[key], label)
            originals[paths[key]] = content
            documents[key] = document
        return documents, originals

    def _graph_source(
        self, session_root: Path, course_id: str
    ) -> tuple[dict[str, Any], dict[Path, bytes]]:
        paths = self._pipeline_paths(session_root, course_id)
        documents: dict[str, Any] = {}
        originals: dict[Path, bytes] = {}
        for key, label in (("course", "课程元数据"), ("graph", "聚类图谱")):
            content, document = self._required_document(paths[key], label)
            originals[paths[key]] = content
            documents[key] = document
        graph_points = documents["graph"].get("points")
        if not isinstance(graph_points, list) or not all(
            isinstance(item, dict) for item in graph_points
        ):
            raise CourseReviewValidationError("graph.points 必须是对象数组")
        identities = _identity_payload(graph_points)
        source_points: list[dict[str, Any]] = []
        for point_id, _ in identities:
            path = self._within(
                paths["points"],
                paths["points"] / f"{point_id}.json",
            )
            content, document = self._required_document(path, f"知识点 {point_id}")
            originals[path] = content
            source_points.append(document)
        documents["source_points"] = source_points
        return documents, originals

    @staticmethod
    def _approval_matches(
        approval: dict[str, Any] | None,
        *,
        course_id: str,
        kind: str,
        identity_sha256: str,
        clusters_sha256: str | None = None,
        prerequisites_sha256: str | None = None,
        review_audit_sha256: str | None = None,
    ) -> bool:
        if not approval or approval.get("schema_version") != _APPROVAL_SCHEMA:
            return False
        review_id = approval.get("review_id")
        approved_at = approval.get("approved_at")
        operation_count = approval.get("operation_count")
        submitted_operations = approval.get("submitted_operations")
        source_revision = approval.get("source_revision")
        source_artifact_hash = approval.get("source_artifact_hash")
        if (
            not isinstance(review_id, str)
            or not review_id.strip()
            or not _is_iso_utc(approved_at)
            or isinstance(operation_count, bool)
            or not isinstance(operation_count, int)
            or operation_count < 0
            or not isinstance(submitted_operations, list)
            or len(submitted_operations) != operation_count
            or not _valid_signed_operations(kind, submitted_operations)
            or isinstance(source_revision, bool)
            or not isinstance(source_revision, int)
            or source_revision < 1
            or not _SHA256.fullmatch(str(source_artifact_hash or ""))
            or not isinstance(approval.get("resume_pending"), bool)
            or not _SHA256.fullmatch(str(approval.get("identity_sha256") or ""))
        ):
            return False
        if (
            approval.get("course_id") != course_id
            or approval.get("kind") != kind
            or approval.get("gate") != _REVIEW_KINDS[kind]
            or approval.get("identity_sha256") != identity_sha256
        ):
            return False
        if kind != "knowledge-graph":
            return True
        return bool(
            _SHA256.fullmatch(str(approval.get("clusters_sha256") or ""))
            and approval.get("clusters_sha256") == clusters_sha256
            and _SHA256.fullmatch(str(approval.get("prerequisites_sha256") or ""))
            and approval.get("prerequisites_sha256") == prerequisites_sha256
            and _SHA256.fullmatch(str(approval.get("review_audit_sha256") or ""))
            and approval.get("review_audit_sha256") == review_audit_sha256
        )

    def _require_knowledge_approval(
        self,
        session_root: Path,
        course_id: str,
        identity_sha256: str,
    ) -> dict[str, Any]:
        approval = _read_optional_json(
            self._approval_path(session_root, course_id, "knowledge-points")
        )
        if not self._approval_matches(
            approval,
            course_id=course_id,
            kind="knowledge-points",
            identity_sha256=identity_sha256,
        ):
            raise CourseReviewConflictError(
                "知识点审核回执缺失或已经失效，不能开始依赖关系审核"
            )
        return approval

    def _require_completed_knowledge_approval(
        self,
        session_root: Path,
        course_id: str,
        identity_sha256: str,
    ) -> dict[str, Any]:
        approval = self._require_knowledge_approval(
            session_root,
            course_id,
            identity_sha256,
        )
        if approval.get("resume_pending") is not False:
            raise CourseReviewConflictError(
                "知识点审核结果尚未恢复到生成流程，不能开始依赖关系审核"
            )
        return approval

    def _acknowledge_knowledge_resume_for_graph(
        self,
        session_root: Path,
        course_id: str,
        identity_sha256: str,
    ) -> dict[str, Any]:
        """Close a stale G2 resume once its durable G6 successor is submitted.

        A browser disconnect can prevent the websocket owner from completing
        the G2 resume claim even though OpenCode has already generated and
        stopped at the G6 review marker. The G6 submission is protected by the
        per-conversation activity lease, so at this point no live backend turn
        can still own that old claim.
        """

        approval = self._require_knowledge_approval(
            session_root,
            course_id,
            identity_sha256,
        )
        if approval.get("resume_pending") is False:
            return approval

        approval_path = self._approval_path(
            session_root,
            course_id,
            "knowledge-points",
        )
        resource_path = self._resource_path(
            session_root,
            course_id,
            "knowledge-points",
        )
        approval_bytes = _capture_bytes(approval_path)
        resource_bytes = _capture_bytes(resource_path)
        if approval_bytes is None or resource_bytes is None:
            raise CourseReviewConflictError(
                "知识点审核恢复状态缺少持久化文件，不能提交知识图谱审核"
            )
        resource = _parse_json_bytes(
            resource_bytes,
            "知识点审核资源",
            resource_path,
        )
        if (
            resource.get("kind") != "knowledge-points"
            or resource.get("course_id") != course_id
            or resource.get("status") != "resolved"
            or resource.get("identity_sha256") != identity_sha256
        ):
            raise CourseReviewConflictError(
                "知识点审核恢复状态与当前知识图谱不匹配，不能自动续接"
            )

        timestamp = _now()
        updated_approval = deepcopy(approval)
        updated_approval["resume_pending"] = False
        updated_approval["resumed_at"] = timestamp
        updated_approval["resume_completed_by"] = "knowledge-graph-successor"
        updated_approval.pop("resume_claim_id", None)
        updated_approval.pop("resume_claimed_at", None)

        updated_resource = deepcopy(resource)
        updated_resource["resume_pending"] = False
        updated_resource["resumed_at"] = timestamp
        updated_resource["resume_completed_by"] = "knowledge-graph-successor"
        updated_resource["updated_at"] = timestamp
        updated_resource.pop("resume_claim_id", None)
        updated_resource.pop("resume_claimed_at", None)
        self._persist_resume_documents(
            approval_path,
            resource_path,
            updated_approval,
            updated_resource,
            {
                approval_path: approval_bytes,
                resource_path: resource_bytes,
            },
        )
        return updated_approval

    def _request_markers(self, session_root: Path) -> list[Path]:
        pipeline_root = session_root / "pipeline"
        _assert_safe_path_chain(pipeline_root)
        if not pipeline_root.exists():
            return []
        if not pipeline_root.is_dir():
            raise CourseReviewUnsafePathError("pipeline 审核路径不是目录")
        markers: list[Path] = []
        for course_root in sorted(pipeline_root.iterdir()):
            _assert_safe_path_chain(course_root)
            if not course_root.is_dir() or not _COURSE_ID.fullmatch(course_root.name):
                continue
            reviews_root = course_root / "reviews"
            _assert_safe_path_chain(reviews_root)
            if not reviews_root.exists():
                continue
            if not reviews_root.is_dir():
                raise CourseReviewUnsafePathError("reviews 审核路径不是目录")
            for kind in _REVIEW_KINDS:
                marker = reviews_root / f"{kind}.request.json"
                _assert_safe_path_chain(marker)
                if marker.is_file():
                    markers.append(marker)
        return markers

    def _load_marker(self, session_root: Path, marker_path: Path) -> dict[str, Any]:
        marker_path = self._within(session_root, marker_path)
        marker = _read_json(marker_path, "审核请求")
        course_id = str(marker.get("course_id") or "")
        kind = str(marker.get("kind") or "")
        if (
            marker.get("schema_version") != _REQUEST_SCHEMA
            or not _COURSE_ID.fullmatch(course_id)
            or kind not in _REVIEW_KINDS
            or marker.get("gate") != _REVIEW_KINDS[kind]
            or not _is_iso_utc(marker.get("requested_at"))
            or marker_path.name != f"{kind}.request.json"
            or marker_path.parent.parent.name != course_id
        ):
            raise CourseReviewValidationError(f"审核请求格式无效：{marker_path}")
        return marker

    def _knowledge_snapshot_from_source(
        self, source: dict[str, Any], course_id: str
    ) -> tuple[dict[str, Any], str, str]:
        course = source["course"]
        index = source["index"]
        manifest = source["manifest"]
        points = index.get("points")
        evidence = manifest.get("pointEvidence")
        review_queue = manifest.get("reviewQueue")
        if not isinstance(points, list) or not all(isinstance(item, dict) for item in points):
            raise CourseReviewValidationError("index.points 必须是对象数组")
        if not isinstance(evidence, list) or not all(isinstance(item, dict) for item in evidence):
            raise CourseReviewValidationError("manifest.pointEvidence 必须是对象数组")
        if len(evidence) != len(points):
            raise CourseReviewValidationError("pointEvidence 必须与 index.points 等长同序")
        if not isinstance(review_queue, list):
            raise CourseReviewValidationError("manifest.reviewQueue 必须是数组")

        identity = _identity_payload(points)
        identity_sha256 = _hash_json(identity)
        evidence_by_id = {
            str(item.get("pointId") or ""): item for item in evidence
        }
        issues_by_id: dict[str, list[dict[str, Any]]] = {}
        for issue in review_queue:
            if not isinstance(issue, dict):
                continue
            point_id = str(issue.get("pointId") or "")
            if point_id:
                issues_by_id.setdefault(point_id, []).append(deepcopy(issue))

        public_points: list[dict[str, Any]] = []
        for point in points:
            point_id = str(point["id"])
            point_evidence = evidence_by_id.get(point_id, {})
            public_points.append({
                "id": point_id,
                "title": str(point["title"]),
                "short_summary": str(point.get("shortSummary") or ""),
                "difficulty": str(point.get("difficulty") or ""),
                "importance": point.get("importance"),
                "key_terms": deepcopy(point.get("keyTerms") or []),
                "kind": str(point_evidence.get("kind") or "concept"),
                "confidence": point_evidence.get("confidence"),
                "scope_status": str(point_evidence.get("scopeStatus") or "needs-review"),
                "issues": issues_by_id.get(point_id, []),
            })

        artifact_hash = _hash_json(
            {"course": course, "index": index, "manifest": manifest},
            sort_keys=True,
        )
        summary = {
            "total": len(public_points),
            "core": sum(item["scope_status"] == "core" for item in public_points),
            "boundary": sum(item["scope_status"] == "boundary" for item in public_points),
            "needs_review": sum(
                item["scope_status"] == "needs-review" for item in public_points
            ),
            "low_confidence": sum(
                isinstance(item["confidence"], (int, float))
                and item["confidence"] < 0.7
                for item in public_points
            ),
            "review_queue": len(review_queue),
        }
        snapshot = {
            "course_title": str(course.get("title") or course_id),
            "summary": summary,
            "points": public_points,
            "review_queue": deepcopy(review_queue),
            "edges": [],
            "related_pairs": [],
            "broken_cycle_edges": [],
        }
        return snapshot, artifact_hash, identity_sha256

    def _knowledge_snapshot(
        self, session_root: Path, course_id: str
    ) -> tuple[dict[str, Any], str, str]:
        source, _ = self._knowledge_source(session_root, course_id)
        return self._knowledge_snapshot_from_source(source, course_id)

    def _graph_snapshot_from_source(
        self, source: dict[str, Any], course_id: str
    ) -> tuple[dict[str, Any], str, str, str, str, str]:
        course = source["course"]
        graph = source["graph"]
        points = graph.get("points")
        if not isinstance(points, list) or not all(isinstance(item, dict) for item in points):
            raise CourseReviewValidationError("graph.points 必须是对象数组")
        identity = _identity_payload(points)
        identity_sha256 = _hash_json(identity)
        clusters, cluster_ids = _graph_clusters(graph)
        cluster_assignments = _cluster_payload(points, cluster_ids)
        clusters_sha256 = _hash_json(
            {
                "clusters": clusters,
                "assignments": cluster_assignments,
            },
            sort_keys=True,
        )
        edge_payload = _edge_payload(points)
        prerequisites_sha256 = _hash_json(edge_payload)
        review_audit_sha256 = _review_audit_sha256(graph)
        audit = (graph.get("generation") or {}).get("refinedPrerequisiteEdges") or []
        reasons = {
            (str(item.get("from") or ""), str(item.get("to") or "")): str(
                item.get("reason") or ""
            )
            for item in audit
            if isinstance(item, dict)
        }
        point_ids = {str(point["id"]) for point in points}
        related_pair_ids: set[tuple[str, str]] = set()
        for point in points:
            point_id = str(point["id"])
            related = point.get("related")
            if not isinstance(related, list):
                raise CourseReviewValidationError(
                    f"知识点 {point_id} 的 related 必须是数组"
                )
            seen_related: set[str] = set()
            for related_id_value in related:
                related_id = (
                    related_id_value.strip()
                    if isinstance(related_id_value, str)
                    else ""
                )
                if (
                    related_id not in point_ids
                    or related_id == point_id
                    or related_id in seen_related
                ):
                    raise CourseReviewValidationError(
                        f"知识点 {point_id} 包含非法、重复、自引用或悬空的 related"
                    )
                seen_related.add(related_id)
                related_pair_ids.add(tuple(sorted((point_id, related_id))))
        public_points = [{
            "id": str(point["id"]),
            "title": str(point["title"]),
            "difficulty": str(point.get("difficulty") or ""),
            "importance": point.get("importance"),
            "clusterIds": deepcopy(point.get("clusterIds") or []),
            "prerequisites": deepcopy(point.get("prerequisites") or []),
            "related": deepcopy(point.get("related") or []),
            "role": str(point.get("role") or ""),
        } for point in points]
        related_pairs = [
            {"first_id": first_id, "second_id": second_id}
            for first_id, second_id in sorted(related_pair_ids)
        ]
        edges = [{
            "dependent_id": dependent_id,
            "prerequisite_id": prerequisite_id,
            "reason": reasons.get((dependent_id, prerequisite_id), ""),
        } for dependent_id, prerequisite_id in edge_payload]
        broken = (graph.get("generation") or {}).get("brokenCycleEdges") or []
        public_broken = []
        if isinstance(broken, list):
            for item in broken:
                if not isinstance(item, dict):
                    continue
                public_broken.append({
                    "dependent_id": str(item.get("from") or ""),
                    "prerequisite_id": str(item.get("to") or ""),
                    "reason": str(item.get("reason") or ""),
                    **(
                        {"cycle_id": str(item["cycleId"])}
                        if item.get("cycleId")
                        else {}
                    ),
                })
        snapshot = {
            "course_title": str(course.get("title") or course_id),
            "summary": {
                "total_points": len(public_points),
                "total_clusters": len(clusters),
                "total_edges": len(edges),
                "refined_edges": len(audit) if isinstance(audit, list) else 0,
                "broken_cycles": len(broken) if isinstance(broken, list) else 0,
            },
            "clusters": clusters,
            "points": public_points,
            "review_queue": [],
            "edges": edges,
            "related_pairs": related_pairs,
            "broken_cycle_edges": public_broken,
        }
        # The optimistic-lock hash covers every graph field that can affect the
        # review or validation outcome. Approval hashes remain the narrower,
        # published identity/prerequisite contracts.
        artifact_hash = _hash_json(
            {
                "course": course,
                "graph": graph,
                "sourcePoints": source["source_points"],
            },
            sort_keys=True,
        )
        return (
            snapshot,
            artifact_hash,
            identity_sha256,
            clusters_sha256,
            prerequisites_sha256,
            review_audit_sha256,
        )

    def _graph_snapshot(
        self, session_root: Path, course_id: str
    ) -> tuple[dict[str, Any], str, str, str, str, str]:
        source, _ = self._graph_source(session_root, course_id)
        return self._graph_snapshot_from_source(source, course_id)

    def _refresh_marker(
        self,
        session_root: Path,
        marker: dict[str, Any],
        *,
        preserve_review_id: str | None = None,
        operation_count: int | None = None,
        expected_resource_bytes: bytes | None = None,
        transaction_writes: dict[Path, bytes | None] | None = None,
        transaction_journal: Path | None = None,
    ) -> dict[str, Any]:
        course_id = str(marker["course_id"])
        kind = str(marker["kind"])
        resource_path = self._resource_path(session_root, course_id, kind)
        previous = _read_optional_json(resource_path)
        if kind == "knowledge-points":
            snapshot, artifact_hash, identity_sha256 = self._knowledge_snapshot(
                session_root, course_id
            )
            clusters_sha256 = None
            prerequisites_sha256 = None
            review_audit_sha256 = None
        else:
            (
                snapshot,
                artifact_hash,
                identity_sha256,
                clusters_sha256,
                prerequisites_sha256,
                review_audit_sha256,
            ) = self._graph_snapshot(session_root, course_id)
            self._require_knowledge_approval(
                session_root,
                course_id,
                identity_sha256,
            )

        approval = _read_optional_json(self._approval_path(session_root, course_id, kind))
        approved = self._approval_matches(
            approval,
            course_id=course_id,
            kind=kind,
            identity_sha256=identity_sha256,
            clusters_sha256=clusters_sha256,
            prerequisites_sha256=prerequisites_sha256,
            review_audit_sha256=review_audit_sha256,
        )
        same_artifact = bool(
            previous
            and previous.get("schema_version") == _RESOURCE_SCHEMA
            and previous.get("artifact_hash") == artifact_hash
        )
        desired_status = "resolved" if approved else "pending"
        approval_fields = (
            "submitted_operations",
            "source_revision",
            "source_artifact_hash",
            "resume_pending",
            "resume_message",
            "display_content",
            "resume_claim_id",
            "resume_claimed_at",
            "resumed_at",
        )
        approval_state_matches = bool(
            not approved
            or (
                isinstance(previous, dict)
                and isinstance(approval, dict)
                and all(previous.get(key) == approval.get(key) for key in approval_fields)
            )
        )
        if (
            same_artifact
            and previous
            and previous.get("status") == desired_status
            and approval_state_matches
            and (
                kind != "knowledge-graph"
                or isinstance(previous.get("related_pairs"), list)
            )
            and preserve_review_id is None
            and operation_count is None
        ):
            return previous
        review_id = preserve_review_id or (
            str(previous.get("id")) if same_artifact and previous else str(uuid.uuid4())
        )
        revision = int(previous.get("revision") or 0) if same_artifact and previous else 0
        if not same_artifact or preserve_review_id:
            revision += 1
        timestamp = _now()
        resource = {
            "schema_version": _RESOURCE_SCHEMA,
            "id": review_id,
            "kind": kind,
            "gate": _REVIEW_KINDS[kind],
            "status": desired_status,
            "revision": max(1, revision),
            "artifact_hash": artifact_hash,
            "identity_sha256": identity_sha256,
            **(
                {"clusters_sha256": clusters_sha256}
                if clusters_sha256 is not None
                else {}
            ),
            **(
                {"prerequisites_sha256": prerequisites_sha256}
                if prerequisites_sha256 is not None
                else {}
            ),
            **(
                {"review_audit_sha256": review_audit_sha256}
                if review_audit_sha256 is not None
                else {}
            ),
            "conversation_id": session_root.name,
            "course_id": course_id,
            "created_at": (
                str(previous.get("created_at"))
                if same_artifact and previous and previous.get("created_at")
                else timestamp
            ),
            "updated_at": timestamp,
            **snapshot,
        }
        if operation_count is not None:
            resource["operation_count"] = operation_count
        if approved and isinstance(approval, dict):
            for key in approval_fields:
                if key in approval:
                    resource[key] = deepcopy(approval[key])
        if transaction_writes is None:
            _write_json_atomic(resource_path, resource)
        else:
            if transaction_journal is None:
                raise CourseReviewValidationError(
                    "审核事务写入缺少持久日志"
                )
            transaction_writes[resource_path] = (
                self._write_review_transaction_json_cas(
                    transaction_journal,
                    resource_path,
                    resource,
                    expected=expected_resource_bytes,
                )
            )
        return resource

    @staticmethod
    def pointer(resource: dict[str, Any]) -> dict[str, Any]:
        return {
            key: deepcopy(resource.get(key))
            for key in (
                "id",
                "kind",
                "gate",
                "status",
                "revision",
                "artifact_hash",
                "conversation_id",
                "course_id",
                "course_title",
                "summary",
                "resume_pending",
                "resume_message",
                "display_content",
            )
        } | {
            "review_url": (
                f"#/reviews/{resource['id']}/"
                + ("points" if resource["kind"] == "knowledge-points" else "graph")
            )
        }

    def pending_for_session(self, session_root: Path) -> list[dict[str, Any]]:
        session_root = self._within(self.workspace_root, session_root)
        with self._lock, self._review_transaction_lock():
            for marker_path in self._request_markers(session_root):
                marker = self._load_marker(session_root, marker_path)
                resource = self._refresh_marker(session_root, marker)
                if resource.get("status") == "pending":
                    # Course generation is sequential: expose one gate at a
                    # time so a stale later marker cannot mask the actionable
                    # earlier review.
                    return [resource]
            return []

    def pending_for_conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        return self.pending_for_session(self._session_root(conversation_id))

    def resume_pending_for_conversation(
        self, conversation_id: str
    ) -> dict[str, Any] | None:
        session_root = self._session_root(conversation_id)
        with self._lock, self._review_transaction_lock():
            resources = self._all_resources()
            graph_courses = {
                str(resource.get("course_id") or "")
                for resource_session, resource in resources
                if (
                    resource_session == session_root
                    and resource.get("kind") == "knowledge-graph"
                )
            }
            candidates: list[dict[str, Any]] = []
            for resource_session, resource in resources:
                if resource_session != session_root or not resource.get("resume_pending"):
                    continue
                # A durable G6 resource proves that this course already advanced
                # beyond its G2 resume. A browser/network interruption can stop
                # the websocket from consuming the older outbox item, but it
                # must never make that stale G2 item mask G6 or replay content.
                if (
                    resource.get("kind") == "knowledge-points"
                    and str(resource.get("course_id") or "") in graph_courses
                ):
                    continue
                refreshed = self.get(str(resource.get("id") or ""))
                if refreshed.get("status") == "resolved" and refreshed.get("resume_pending"):
                    candidates.append(refreshed)
            if not candidates:
                return None
            candidates.sort(
                key=lambda resource: (
                    resource.get("kind") == "knowledge-graph",
                    str(resource.get("updated_at") or ""),
                ),
                reverse=True,
            )
            return candidates[0]

    def has_resolved_knowledge_review(
        self,
        conversation_id: str,
        course_id: str,
    ) -> bool:
        if not _COURSE_ID.fullmatch(str(course_id)):
            return False
        session_root = self._session_root(conversation_id)
        with self._lock, self._review_transaction_lock():
            for resource_session, resource in self._all_resources():
                if (
                    resource_session != session_root
                    or resource.get("kind") != "knowledge-points"
                    or resource.get("course_id") != course_id
                ):
                    continue
                try:
                    refreshed = self.get(str(resource.get("id") or ""))
                except CourseReviewError:
                    continue
                if refreshed.get("status") == "resolved":
                    return True
        return False

    def resolved_knowledge_course_for_conversation(
        self,
        conversation_id: str,
    ) -> str | None:
        """Return the one unfinished pipeline course authorized past G2."""
        session_root = self._session_root(conversation_id)
        pipeline_root = session_root / "pipeline"
        _assert_safe_path_chain(pipeline_root)
        if not pipeline_root.exists():
            return None
        if not pipeline_root.is_dir():
            raise CourseReviewUnsafePathError("pipeline 审核路径不是目录")
        active_course_ids: list[str] = []
        for course_root in pipeline_root.iterdir():
            _assert_safe_path_chain(course_root)
            if not course_root.is_dir() or not _COURSE_ID.fullmatch(course_root.name):
                continue
            published_course_path = (
                session_root / "courses" / course_root.name / "course.json"
            )
            published_course = _read_optional_json(published_course_path)
            if published_course and published_course.get("status") == "published":
                continue
            active_course_ids.append(course_root.name)
        if len(active_course_ids) != 1:
            return None
        course_id = active_course_ids[0]
        return (
            course_id
            if self.has_resolved_knowledge_review(conversation_id, course_id)
            else None
        )

    def _all_resources(self) -> list[tuple[Path, dict[str, Any]]]:
        resources: list[tuple[Path, dict[str, Any]]] = []
        if not self.workspace_root.is_dir():
            return resources
        for session_root in self.workspace_root.iterdir():
            _assert_safe_path_chain(session_root)
            if not session_root.is_dir():
                continue
            review_root = session_root / ".course-reviews"
            _assert_safe_path_chain(review_root)
            if not review_root.exists():
                continue
            if not review_root.is_dir():
                raise CourseReviewUnsafePathError("审核资源路径不是目录")
            for course_root in review_root.iterdir():
                _assert_safe_path_chain(course_root)
                if not course_root.is_dir():
                    continue
                for kind in _REVIEW_KINDS:
                    path_value = course_root / f"{kind}.json"
                    resource = _read_optional_json(path_value)
                    if resource:
                        resources.append((session_root, resource))
        return resources

    def get(self, review_id: str) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            for session_root, resource in self._all_resources():
                if resource.get("id") != review_id:
                    continue
                course_id = str(resource.get("course_id") or "")
                kind = str(resource.get("kind") or "")
                marker_path = (
                    session_root
                    / "pipeline"
                    / course_id
                    / "reviews"
                    / f"{kind}.request.json"
                )
                _assert_safe_path_chain(marker_path)
                if marker_path.is_file():
                    marker = self._load_marker(session_root, marker_path)
                    refreshed = self._refresh_marker(session_root, marker)
                    if refreshed.get("id") != review_id:
                        raise CourseReviewConflictError("审核数据已经更新，请打开最新审核任务")
                    return refreshed
                return resource
        raise CourseReviewNotFoundError("审核任务不存在")

    def _run_validator(self, command: list[str], *, cwd: Path, label: str) -> None:
        try:
            completed = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise CourseReviewValidationError(f"{label}无法完成：{exc}") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "未知错误").strip()
            raise CourseReviewValidationError(
                f"{label}未通过",
                details=[line for line in detail.splitlines() if line][:20],
            )

    def _validate_submission(
        self,
        resource: dict[str, Any],
        *,
        conversation_id: str,
        revision: int,
        artifact_hash: str,
    ) -> tuple[Path, dict[str, Any]]:
        if resource.get("conversation_id") != _safe_conversation_id(conversation_id):
            raise CourseReviewNotFoundError("审核任务与当前会话不匹配")
        if resource.get("status") != "pending":
            raise CourseReviewConflictError("审核任务已经处理")
        if resource.get("revision") != revision or resource.get("artifact_hash") != artifact_hash:
            raise CourseReviewConflictError("审核数据已经更新，请刷新后重新确认")
        session_root = self._session_root(conversation_id)
        current = self.get(str(resource["id"]))
        if (
            current.get("revision") != revision
            or current.get("artifact_hash") != artifact_hash
            or current.get("status") != "pending"
        ):
            raise CourseReviewConflictError("审核数据已经更新，请刷新后重新确认")
        return session_root, current

    @staticmethod
    def _assert_source_unchanged(originals: dict[Path, bytes]) -> None:
        for path, expected in originals.items():
            current = _capture_bytes(path)
            if current != expected:
                raise CourseReviewConflictError(
                    "审核源数据在提交期间发生变化，请刷新后重新确认"
                )

    @staticmethod
    def _assert_output_unchanged(expected_outputs: dict[Path, bytes | None]) -> None:
        for path, expected in expected_outputs.items():
            if _capture_bytes(path) != expected:
                raise CourseReviewConflictError(
                    "审核写回结果在校验期间发生变化，提交已取消"
                )

    def _apply_knowledge_operations(
        self,
        session_root: Path,
        resource: dict[str, Any],
        operations: list[dict[str, Any]],
        source: dict[str, Any],
        source_bytes: dict[Path, bytes],
        transaction_writes: dict[Path, bytes | None],
        transaction_journal: Path,
    ) -> dict[Path, bytes]:
        course_id = str(resource["course_id"])
        paths = self._pipeline_paths(session_root, course_id)
        _assert_safe_path_chain(paths["points"])
        details = list(paths["points"].glob("*.json")) if paths["points"].is_dir() else []
        if details:
            raise CourseReviewConflictError(
                "知识点详情生成已经开始，不能再修改身份清单；请回退到 G1 后重新审核"
            )
        index = deepcopy(source["index"])
        manifest = deepcopy(source["manifest"])
        points = index.get("points")
        evidence = manifest.get("pointEvidence")
        review_queue = manifest.get("reviewQueue")
        if not isinstance(points, list) or not isinstance(evidence, list) or not isinstance(review_queue, list):
            raise CourseReviewValidationError("知识点索引或生成清单格式无效")
        existing = {str(point.get("id") or ""): point for point in points if isinstance(point, dict)}
        deleted: set[str] = set()
        additions: list[dict[str, Any]] = []
        touched: set[str] = set()
        for operation in operations:
            if not isinstance(operation, dict):
                raise CourseReviewValidationError("知识点审核操作必须是对象")
            op = operation.get("op")
            if op == "delete":
                if set(operation) != {"op", "point_id"}:
                    raise CourseReviewValidationError("delete 只允许 op 和 point_id 字段")
                point_id = str(operation.get("point_id") or "")
                if point_id not in existing or point_id in touched:
                    raise CourseReviewValidationError(f"不能删除不存在或重复操作的知识点：{point_id}")
                deleted.add(point_id)
                touched.add(point_id)
            elif op == "add":
                if set(operation) != {"op", "point"} or not isinstance(operation.get("point"), dict):
                    raise CourseReviewValidationError("add 只允许包含 id/title 的 point 对象")
                point = operation["point"]
                if set(point) != {"id", "title"}:
                    raise CourseReviewValidationError("新增知识点只允许 id 和 title，不支持重命名或合并")
                point_id = str(point.get("id") or "").strip()
                title = str(point.get("title") or "").strip()
                if not _COURSE_ID.fullmatch(point_id):
                    raise CourseReviewValidationError("新增知识点 ID 必须是小写 kebab-case")
                if not title or len(title) > 160:
                    raise CourseReviewValidationError("新增知识点标题必须为 1-160 个字符")
                if point_id in existing or point_id in touched:
                    raise CourseReviewValidationError(f"知识点 ID 已存在或重复操作：{point_id}")
                additions.append({"id": point_id, "title": title})
                touched.add(point_id)
            else:
                raise CourseReviewValidationError("知识点审核只支持 add 或 delete")

        retained = [deepcopy(point) for point in points if point.get("id") not in deleted]
        if not retained and not additions:
            raise CourseReviewValidationError("知识点清单至少需要保留一个知识点")
        retained_evidence = [
            deepcopy(item)
            for item in evidence
            if isinstance(item, dict) and item.get("pointId") not in deleted
        ]
        generation = manifest.get("generation")
        if not isinstance(generation, dict):
            raise CourseReviewValidationError("manifest.generation 必须是对象")
        evidence_mode = generation.get("evidenceMode")
        source_refs: list[str] = []
        if evidence_mode == "researched" and additions:
            sources = manifest.get("sources")
            if not isinstance(sources, list):
                raise CourseReviewValidationError("researched 模式的 manifest.sources 必须是数组")
            review_created_at = resource.get("created_at")
            if not _is_iso_utc(review_created_at):
                raise CourseReviewConflictError("知识点审核创建时间无效，请刷新后重试")
            review_source = {
                "id": "src-user-review",
                "type": "reference",
                "title": "课程知识点结构化用户审核",
                "locator": f"course-studio://reviews/{resource['id']}",
                "accessedAt": str(review_created_at)[:10],
            }
            existing_review_sources = [
                item
                for item in sources
                if isinstance(item, dict) and item.get("id") == review_source["id"]
            ]
            if existing_review_sources:
                if (
                    len(existing_review_sources) != 1
                    or existing_review_sources[0] != review_source
                ):
                    raise CourseReviewValidationError(
                        "manifest.sources 中的 src-user-review 与当前审核来源冲突"
                    )
            else:
                sources.append(review_source)
            source_refs = [review_source["id"]]
        for addition in additions:
            title = addition["title"]
            second_term = "课程要点" if title == "核心概念" else "核心概念"
            retained.append({
                "id": addition["id"],
                "title": title,
                "shortSummary": _default_summary(title),
                "difficulty": "中等",
                "importance": 0.5,
                "keyTerms": [title, second_term],
            })
            retained_evidence.append({
                "pointId": addition["id"],
                "title": title,
                "kind": "concept",
                "sourceRefs": source_refs,
                "confidence": 0.6,
                "scopeStatus": "core",
            })
        index["points"] = retained
        manifest["pointEvidence"] = retained_evidence
        manifest["reviewQueue"] = [
            deepcopy(item)
            for item in review_queue
            if not isinstance(item, dict) or item.get("pointId") not in deleted
        ]
        generation["pointCount"] = len(retained)

        self._assert_source_unchanged(source_bytes)
        index_output = self._write_review_transaction_json_cas(
            transaction_journal,
            paths["index"],
            index,
            expected=source_bytes[paths["index"]],
        )
        transaction_writes[paths["index"]] = index_output
        manifest_output = self._write_review_transaction_json_cas(
            transaction_journal,
            paths["manifest"],
            manifest,
            expected=source_bytes[paths["manifest"]],
        )
        transaction_writes[paths["manifest"]] = manifest_output
        expected_outputs = {
            paths["index"]: index_output,
            paths["manifest"]: manifest_output,
        }
        validator = (
            self.project_root
            / "skills"
            / "candidate-knowledge-point-generator"
            / "scripts"
            / "validate_output.mjs"
        )
        self._run_validator(
            ["node", str(validator), "--root", str(paths["content_root"]), "--phase", "index"],
            cwd=session_root,
            label="知识点索引校验",
        )
        self._assert_output_unchanged(expected_outputs)
        return expected_outputs

    def _apply_graph_operations(
        self,
        session_root: Path,
        resource: dict[str, Any],
        operations: list[dict[str, Any]],
        source: dict[str, Any],
        source_bytes: dict[Path, bytes],
        transaction_writes: dict[Path, bytes | None],
        transaction_journal: Path,
        approval: dict[str, Any],
        approval_expected: bytes | None,
    ) -> dict[Path, bytes]:
        course_id = str(resource["course_id"])
        paths = self._pipeline_paths(session_root, course_id)
        graph = deepcopy(source["graph"])
        graph_points = graph.get("points")
        if not isinstance(graph_points, list) or not all(isinstance(item, dict) for item in graph_points):
            raise CourseReviewValidationError("graph.points 必须是对象数组")
        point_order = [str(point.get("id") or "") for point in graph_points]
        point_ids = set(point_order)
        _, cluster_ids = _graph_clusters(graph)
        _cluster_payload(graph_points, cluster_ids)
        current_edges = {tuple(edge) for edge in _edge_payload(graph_points)}
        next_edges = set(current_edges)
        touched_edges: set[tuple[str, str]] = set()
        touched_clusters: set[str] = set()
        operation_reasons: dict[tuple[str, str, str], str] = {}
        related_pairs: set[frozenset[str]] = set()
        for point in graph_points:
            point_id = str(point["id"])
            for related_id in point.get("related") or []:
                if isinstance(related_id, str):
                    related_pairs.add(frozenset((point_id, related_id)))

        point_by_id = {
            str(point["id"]): point
            for point in graph_points
        }
        for operation in operations:
            if not isinstance(operation, dict):
                raise CourseReviewValidationError("知识图谱审核操作必须是对象")
            op = operation.get("op")
            if not isinstance(op, str):
                raise CourseReviewValidationError("知识图谱审核 op 必须是字符串")
            if op == "set-clusters":
                if set(operation) != {"op", "point_id", "cluster_ids"}:
                    raise CourseReviewValidationError(
                        "set-clusters 只允许 op/point_id/cluster_ids"
                    )
                point_id = str(operation.get("point_id") or "")
                raw_cluster_ids = operation.get("cluster_ids")
                if point_id not in point_by_id:
                    raise CourseReviewValidationError(
                        "set-clusters 必须引用当前课程中的知识点"
                    )
                if point_id in touched_clusters:
                    raise CourseReviewValidationError(
                        "同一知识点不能重复设置 cluster_ids"
                    )
                if not isinstance(raw_cluster_ids, list) or not raw_cluster_ids:
                    raise CourseReviewValidationError(
                        "set-clusters.cluster_ids 必须是非空数组"
                    )
                normalized_cluster_ids: list[str] = []
                seen_cluster_ids: set[str] = set()
                for value in raw_cluster_ids:
                    cluster_id = str(value or "")
                    if (
                        cluster_id not in cluster_ids
                        or cluster_id in seen_cluster_ids
                    ):
                        raise CourseReviewValidationError(
                            "set-clusters 包含非法、重复或不存在的知识簇"
                        )
                    seen_cluster_ids.add(cluster_id)
                    normalized_cluster_ids.append(cluster_id)
                point_by_id[point_id]["clusterIds"] = normalized_cluster_ids
                touched_clusters.add(point_id)
                continue

            canonical_prerequisite_ops = {
                "add-prerequisite": "add",
                "remove-prerequisite": "remove",
            }
            legacy_prerequisite_ops = {"add": "add", "remove": "remove"}
            if op in canonical_prerequisite_ops:
                if set(operation) != {
                    "op",
                    "point_id",
                    "prerequisite_id",
                    "reason",
                }:
                    raise CourseReviewValidationError(
                        "先修关系操作只允许 op/point_id/prerequisite_id/reason"
                    )
                dependent_id = str(operation.get("point_id") or "")
                normalized_op = canonical_prerequisite_ops[str(op)]
            elif op in legacy_prerequisite_ops:
                if set(operation) != {
                    "op",
                    "dependent_id",
                    "prerequisite_id",
                    "reason",
                }:
                    raise CourseReviewValidationError(
                        "兼容先修关系操作只允许 op/dependent_id/prerequisite_id/reason"
                    )
                dependent_id = str(operation.get("dependent_id") or "")
                normalized_op = legacy_prerequisite_ops[str(op)]
            else:
                raise CourseReviewValidationError(
                    "知识图谱审核只支持 set-clusters、add-prerequisite 或 remove-prerequisite"
                )
            prerequisite_id = str(operation.get("prerequisite_id") or "")
            reason = str(operation.get("reason") or "").strip()
            edge = (dependent_id, prerequisite_id)
            if dependent_id not in point_ids or prerequisite_id not in point_ids:
                raise CourseReviewValidationError("依赖边必须引用当前课程中的知识点")
            if dependent_id == prerequisite_id:
                raise CourseReviewValidationError("知识点不能依赖自身")
            if not reason or len(reason) > 500:
                raise CourseReviewValidationError("每项依赖变更都需要 1-500 个字符的原因")
            if edge in touched_edges:
                raise CourseReviewValidationError("同一依赖边不能重复或反向操作多次")
            if normalized_op == "add":
                if edge in next_edges:
                    raise CourseReviewValidationError("不能添加已经存在的 prerequisite")
                if frozenset(edge) in related_pairs:
                    raise CourseReviewValidationError(
                        "该知识点对已有 related 关系；related 为只读，不能同时添加 prerequisite"
                    )
                next_edges.add(edge)
            else:
                if edge not in next_edges:
                    raise CourseReviewValidationError("不能移除不存在的 prerequisite")
                next_edges.remove(edge)
            touched_edges.add(edge)
            operation_reasons[(normalized_op, dependent_id, prerequisite_id)] = reason

        cycle = _cycle_path(point_order, next_edges)
        if cycle:
            raise CourseReviewValidationError(
                "依赖变更会形成环：" + " -> ".join(cycle),
                details=cycle,
            )
        for dependent_id, prerequisite_id in next_edges:
            if frozenset((dependent_id, prerequisite_id)) in related_pairs:
                raise CourseReviewValidationError(
                    f"{dependent_id} 与 {prerequisite_id} 同时存在 related 和 prerequisite"
                )

        index_by_id = {point_id: index for index, point_id in enumerate(point_order)}
        prerequisites_by_id = {point_id: [] for point_id in point_order}
        for dependent_id, prerequisite_id in sorted(
            next_edges,
            key=lambda edge: (index_by_id[edge[0]], index_by_id[edge[1]]),
        ):
            prerequisites_by_id[dependent_id].append(prerequisite_id)
        for point in graph_points:
            point["prerequisites"] = prerequisites_by_id[str(point["id"])]
        # Re-validate all assignments after applying set-clusters. This also
        # binds role/related to the signed cluster approval contract.
        _cluster_payload(graph_points, cluster_ids)

        source_points = deepcopy(source["source_points"])
        source_edges = {tuple(edge) for edge in _edge_payload(source_points)}
        existing_audit = (graph.get("generation") or {}).get("refinedPrerequisiteEdges") or []
        existing_reasons = {
            (
                str(item.get("op") or ""),
                str(item.get("from") or ""),
                str(item.get("to") or ""),
            ): str(item.get("reason") or "")
            for item in existing_audit
            if isinstance(item, dict)
        }
        audit: list[dict[str, str]] = []
        for op, edges in (
            ("remove", sorted(source_edges - next_edges)),
            ("add", sorted(next_edges - source_edges)),
        ):
            for dependent_id, prerequisite_id in edges:
                reason = (
                    operation_reasons.get((op, dependent_id, prerequisite_id))
                    or existing_reasons.get((op, dependent_id, prerequisite_id))
                    or "课程依赖审核确认的先修关系调整"
                )
                audit.append({
                    "op": op,
                    "from": dependent_id,
                    "to": prerequisite_id,
                    "reason": reason,
                })
        generation = graph.get("generation")
        if not isinstance(generation, dict):
            raise CourseReviewValidationError("graph.generation 必须是对象")
        generation["refinedPrerequisiteEdges"] = audit
        broken = generation.get("brokenCycleEdges")
        if isinstance(broken, list):
            removed = source_edges - next_edges
            generation["brokenCycleEdges"] = [
                deepcopy(item)
                for item in broken
                if isinstance(item, dict)
                and (str(item.get("from") or ""), str(item.get("to") or "")) in removed
            ]

        approval_path = self._approval_path(session_root, course_id, "knowledge-graph")
        approval = deepcopy(approval)
        approval["identity_sha256"] = _hash_json(_identity_payload(graph_points))
        clusters, cluster_ids = _graph_clusters(graph)
        approval["clusters_sha256"] = _hash_json(
            {
                "clusters": clusters,
                "assignments": _cluster_payload(graph_points, cluster_ids),
            },
            sort_keys=True,
        )
        approval["prerequisites_sha256"] = _hash_json(_edge_payload(graph_points))
        approval["review_audit_sha256"] = _review_audit_sha256(graph)
        self._assert_source_unchanged(source_bytes)
        graph_output = self._write_review_transaction_json_cas(
            transaction_journal,
            paths["graph"],
            graph,
            expected=source_bytes[paths["graph"]],
        )
        transaction_writes[paths["graph"]] = graph_output
        approval_output = self._write_review_transaction_json_cas(
            transaction_journal,
            approval_path,
            approval,
            expected=approval_expected,
        )
        transaction_writes[approval_path] = approval_output
        expected_outputs = {
            paths["graph"]: graph_output,
            approval_path: approval_output,
        }
        graph_skill = (
            self.project_root
            / "skills"
            / "knowledge-cluster-builder"
            / "knowledge-cluster-builder"
        )
        self._run_validator(
            [
                "node",
                str(graph_skill / "scripts" / "assemble-graph-points.mjs"),
                str(paths["content_root"]),
                str(paths["graph"]),
                "--check",
            ],
            cwd=session_root,
            label="图谱内容透传校验",
        )
        self._run_validator(
            ["node", str(graph_skill / "scripts" / "check-graph.mjs"), str(paths["graph"])],
            cwd=session_root,
            label="依赖图校验",
        )
        pipeline_checker = (
            self.project_root
            / "skills"
            / "knowledge-pipeline-orchestrator"
            / "scripts"
            / "check-pipeline.mjs"
        )
        self._run_validator(
            [
                "node",
                str(pipeline_checker),
                str(paths["content_root"]),
                str(paths["graph"]),
                "--phase",
                "all",
                "--json",
            ],
            cwd=session_root,
            label="课程流水线校验",
        )
        self._assert_output_unchanged(expected_outputs)
        return expected_outputs

    def submit(
        self,
        review_id: str,
        *,
        conversation_id: str,
        revision: int,
        artifact_hash: str,
        operations: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not isinstance(operations, list):
            raise CourseReviewValidationError("审核 operations 必须是数组")
        if len(operations) > 500:
            raise CourseReviewValidationError("单次审核最多提交 500 项变更")
        with self._lock, self._review_transaction_lock():
            resource = self.get(review_id)
            if resource.get("conversation_id") != _safe_conversation_id(conversation_id):
                raise CourseReviewNotFoundError("审核任务与当前会话不匹配")
            if resource.get("status") == "resolved":
                if (
                    resource.get("source_revision") == revision
                    and resource.get("source_artifact_hash") == artifact_hash
                    and resource.get("submitted_operations") == operations
                ):
                    return self._submission_response(resource)
                raise CourseReviewConflictError("审核任务已经处理，重试参数与原提交不一致")
            session_root, resource = self._validate_submission(
                resource,
                conversation_id=conversation_id,
                revision=revision,
                artifact_hash=artifact_hash,
            )
            kind = str(resource["kind"])
            course_id = str(resource["course_id"])
            paths = self._pipeline_paths(session_root, course_id)
            knowledge_approval = self._approval_path(
                session_root, course_id, "knowledge-points"
            )
            prerequisite_approval = self._approval_path(
                session_root, course_id, "knowledge-graph"
            )
            resource_path = self._resource_path(session_root, course_id, kind)
            if kind == "knowledge-points":
                source, source_bytes = self._knowledge_source(session_root, course_id)
                _, current_artifact_hash, _ = self._knowledge_snapshot_from_source(
                    source, course_id
                )
                mutable_paths = [
                    paths["index"],
                    paths["manifest"],
                    knowledge_approval,
                    prerequisite_approval,
                    resource_path,
                ]
            else:
                source, source_bytes = self._graph_source(session_root, course_id)
                (
                    _,
                    current_artifact_hash,
                    current_identity_sha256,
                    _,
                    _,
                    _,
                ) = self._graph_snapshot_from_source(source, course_id)
                self._acknowledge_knowledge_resume_for_graph(
                    session_root,
                    course_id,
                    current_identity_sha256,
                )
                self._require_completed_knowledge_approval(
                    session_root,
                    course_id,
                    current_identity_sha256,
                )
                mutable_paths = [paths["graph"], prerequisite_approval, resource_path]
            if current_artifact_hash != artifact_hash:
                raise CourseReviewConflictError("审核源数据已经变化，请刷新后重新确认")

            originals = {path_value: _capture_bytes(path_value) for path_value in mutable_paths}
            transaction_writes: dict[Path, bytes | None] = {}
            display_content, resume_message = self._resume_content(resource, len(operations))
            approval = {
                "schema_version": _APPROVAL_SCHEMA,
                "review_id": review_id,
                "course_id": course_id,
                "kind": kind,
                "gate": _REVIEW_KINDS[kind],
                "approved_at": _now(),
                "operation_count": len(operations),
                "submitted_operations": deepcopy(operations),
                "source_revision": revision,
                "source_artifact_hash": artifact_hash,
                "resume_pending": True,
                "resume_message": resume_message,
                "display_content": display_content,
            }
            transaction_journal = self._begin_review_transaction(
                session_root,
                resource,
                originals,
            )

            try:
                if kind == "knowledge-points":
                    expected_outputs = self._apply_knowledge_operations(
                        session_root,
                        resource,
                        operations,
                        source,
                        source_bytes,
                        transaction_writes,
                        transaction_journal,
                    )
                    signed_state = {**source_bytes, **expected_outputs}
                    self._assert_output_unchanged(signed_state)
                    updated_source, _ = self._knowledge_source(session_root, course_id)
                    _, _, identity_sha256 = self._knowledge_snapshot_from_source(
                        updated_source, course_id
                    )
                    approval["identity_sha256"] = identity_sha256
                    self._assert_output_unchanged(signed_state)
                    approval_output = self._write_review_transaction_json_cas(
                        transaction_journal,
                        knowledge_approval,
                        approval,
                        expected=originals[knowledge_approval],
                    )
                    transaction_writes[knowledge_approval] = approval_output
                    expected_outputs[knowledge_approval] = approval_output
                    self._unlink_review_transaction_cas(
                        transaction_journal,
                        prerequisite_approval,
                        expected=originals[prerequisite_approval],
                    )
                    if originals[prerequisite_approval] is not None:
                        transaction_writes[prerequisite_approval] = None
                    expected_outputs[prerequisite_approval] = None
                else:
                    expected_outputs = self._apply_graph_operations(
                        session_root,
                        resource,
                        operations,
                        source,
                        source_bytes,
                        transaction_writes,
                        transaction_journal,
                        approval,
                        originals[prerequisite_approval],
                    )

                signed_state = {**source_bytes, **expected_outputs}
                self._assert_output_unchanged(signed_state)

                marker = {"course_id": course_id, "kind": kind}
                resolved = self._refresh_marker(
                    session_root,
                    marker,
                    preserve_review_id=review_id,
                    operation_count=len(operations),
                    expected_resource_bytes=originals[resource_path],
                    transaction_writes=transaction_writes,
                    transaction_journal=transaction_journal,
                )
                if resolved.get("status") != "resolved":
                    raise CourseReviewConflictError("审核回执写入后未能匹配当前产物")
                self._assert_output_unchanged(signed_state)
                self._commit_review_transaction(transaction_journal)
                return self._submission_response(resolved)
            except Exception as exc:
                try:
                    self._recover_review_transaction(transaction_journal)
                except Exception as recovery_exc:
                    raise CourseReviewError(
                        f"审核提交失败且持久事务无法恢复：{recovery_exc}"
                    ) from exc
                raise

    @staticmethod
    def _resume_content(
        resource: dict[str, Any], operation_count: int
    ) -> tuple[str, str]:
        review_id = str(resource["id"])
        course_id = str(resource["course_id"])
        if resource["kind"] == "knowledge-points":
            display_content = (
                f"已确认 {resource['course_title']} 的知识点清单"
                + (f"，并提交 {operation_count} 项增删" if operation_count else "")
            )
            resume_message = (
                f"知识点审核 {review_id} 已由用户在结构化审核页完成，"
                "后端已机械应用并写入有效回执。请依次调用 course_pipeline 的 "
                f'{{"action":"validate-index","courseId":"{course_id}"}}、'
                f'{{"action":"review-knowledge-points","courseId":"{course_id}"}}；'
                "确认返回 status=approved 后，再调用 "
                f'{{"action":"init-points","courseId":"{course_id}"}} '
                "并从 G3 继续。不要再次询问相同审核。"
            )
        else:
            display_content = (
                f"已确认 {resource['course_title']} 的知识簇与先修关系"
                + (f"，并提交 {operation_count} 项变更" if operation_count else "")
            )
            resume_message = (
                f"知识图谱审核 {review_id} 已由用户在结构化审核页完成，"
                "后端已验证聚类、DAG、互斥关系并写入有效回执。请依次调用 course_pipeline 的 "
                f'{{"action":"assemble-graph","courseId":"{course_id}"}}、'
                f'{{"action":"assemble-graph-check","courseId":"{course_id}"}}、'
                f'{{"action":"check-graph","courseId":"{course_id}"}} 和 '
                f'{{"action":"review-knowledge-graph","courseId":"{course_id}"}}；'
                "确认返回 status=approved 后进入 G7。不要再次询问相同审核。"
            )
        return display_content, resume_message

    @staticmethod
    def _submission_response(resource: dict[str, Any]) -> dict[str, Any]:
        resume_message = resource.get("resume_message")
        display_content = resource.get("display_content")
        if not isinstance(resume_message, str) or not isinstance(display_content, str):
            raise CourseReviewConflictError("审核恢复信息缺失，不能重放提交响应")
        return {
            "ok": True,
            "review": resource,
            "resume_message": resume_message,
            "display_content": display_content,
        }

    def get_resume(self, review_id: str, *, conversation_id: str) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            resource = self.get(review_id)
            if resource.get("conversation_id") != _safe_conversation_id(conversation_id):
                raise CourseReviewNotFoundError("审核任务与当前会话不匹配")
            if resource.get("status") != "resolved" or not resource.get("resume_pending"):
                raise CourseReviewConflictError("审核恢复任务不存在或已经消费")
            return self._submission_response(resource)

    def _resume_documents(
        self,
        resource: dict[str, Any],
        *,
        conversation_id: str,
    ) -> tuple[Path, Path, dict[str, Any], dict[Path, bytes | None]]:
        session_root = self._session_root(conversation_id)
        course_id = str(resource["course_id"])
        kind = str(resource["kind"])
        approval_path = self._approval_path(session_root, course_id, kind)
        resource_path = self._resource_path(session_root, course_id, kind)
        approval_bytes = _capture_bytes(approval_path)
        resource_bytes = _capture_bytes(resource_path)
        if approval_bytes is None or resource_bytes is None:
            raise CourseReviewConflictError("审核恢复持久化文件缺失")
        approval = _parse_json_bytes(approval_bytes, "审核回执", approval_path)
        on_disk_resource = _parse_json_bytes(resource_bytes, "审核资源", resource_path)
        if on_disk_resource != resource or approval.get("review_id") != resource.get("id"):
            raise CourseReviewConflictError("审核恢复状态已经变化，请重试")
        return (
            approval_path,
            resource_path,
            approval,
            {approval_path: approval_bytes, resource_path: resource_bytes},
        )

    @staticmethod
    def _persist_resume_documents(
        approval_path: Path,
        resource_path: Path,
        approval: dict[str, Any],
        resource: dict[str, Any],
        originals: dict[Path, bytes | None],
    ) -> None:
        writes: dict[Path, bytes | None] = {}
        try:
            # The approval is the recovery source of truth. Write the resource
            # first so a crash before the approval CAS is recoverable as pending.
            writes[resource_path] = _write_json_cas(
                resource_path,
                resource,
                expected=originals[resource_path],
            )
            writes[approval_path] = _write_json_cas(
                approval_path,
                approval,
                expected=originals[approval_path],
            )
        except Exception as exc:
            rollback_errors = _rollback_owned_writes(originals, writes)
            if rollback_errors:
                raise CourseReviewError(
                    "审核恢复状态写入失败且回滚不完整：" + "；".join(rollback_errors)
                ) from exc
            raise

    def claim_resume(
        self,
        review_id: str,
        *,
        conversation_id: str,
        claim_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            response = self.get_resume(review_id, conversation_id=conversation_id)
            resource = response["review"]
            normalized_claim = str(claim_id).strip()
            if not normalized_claim or len(normalized_claim) > 160:
                raise CourseReviewValidationError("审核恢复 claim_id 无效")
            existing_claim = str(resource.get("resume_claim_id") or "")
            claimed_at = _parse_iso_utc(resource.get("resume_claimed_at"))
            if (
                existing_claim
                and claimed_at is not None
                and datetime.now(UTC) - claimed_at < _resume_claim_lease()
            ):
                raise CourseReviewConflictError("审核恢复任务正在由另一个请求处理")
            approval_path, resource_path, approval, originals = self._resume_documents(
                resource,
                conversation_id=conversation_id,
            )
            timestamp = _now()
            approval["resume_claim_id"] = normalized_claim
            approval["resume_claimed_at"] = timestamp
            updated_resource = deepcopy(resource)
            updated_resource["resume_claim_id"] = normalized_claim
            updated_resource["resume_claimed_at"] = timestamp
            updated_resource["updated_at"] = timestamp
            self._persist_resume_documents(
                approval_path,
                resource_path,
                approval,
                updated_resource,
                originals,
            )
            return self._submission_response(updated_resource)

    def release_resume(
        self,
        review_id: str,
        *,
        conversation_id: str,
        claim_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            response = self.get_resume(review_id, conversation_id=conversation_id)
            resource = response["review"]
            if resource.get("resume_claim_id") != claim_id:
                raise CourseReviewConflictError("审核恢复 claim 已变化，不能释放")
            approval_path, resource_path, approval, originals = self._resume_documents(
                resource,
                conversation_id=conversation_id,
            )
            approval.pop("resume_claim_id", None)
            approval.pop("resume_claimed_at", None)
            updated_resource = deepcopy(resource)
            updated_resource.pop("resume_claim_id", None)
            updated_resource.pop("resume_claimed_at", None)
            updated_resource["updated_at"] = _now()
            self._persist_resume_documents(
                approval_path,
                resource_path,
                approval,
                updated_resource,
                originals,
            )
            return self._submission_response(updated_resource)

    def renew_resume_claim(
        self,
        review_id: str,
        *,
        conversation_id: str,
        claim_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            response = self.get_resume(review_id, conversation_id=conversation_id)
            resource = response["review"]
            if resource.get("resume_claim_id") != claim_id:
                raise CourseReviewConflictError("审核恢复 claim 已变化，不能续租")
            approval_path, resource_path, approval, originals = self._resume_documents(
                resource,
                conversation_id=conversation_id,
            )
            timestamp = _now()
            approval["resume_claimed_at"] = timestamp
            updated_resource = deepcopy(resource)
            updated_resource["resume_claimed_at"] = timestamp
            updated_resource["updated_at"] = timestamp
            self._persist_resume_documents(
                approval_path,
                resource_path,
                approval,
                updated_resource,
                originals,
            )
            return self._submission_response(updated_resource)

    def complete_resume(
        self,
        review_id: str,
        *,
        conversation_id: str,
        claim_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._review_transaction_lock():
            response = self.get_resume(review_id, conversation_id=conversation_id)
            resource = response["review"]
            if resource.get("resume_claim_id") != claim_id:
                raise CourseReviewConflictError("审核恢复 claim 已变化，不能完成")
            approval_path, resource_path, approval, originals = self._resume_documents(
                resource,
                conversation_id=conversation_id,
            )
            timestamp = _now()
            approval["resume_pending"] = False
            approval["resumed_at"] = timestamp
            approval.pop("resume_claim_id", None)
            approval.pop("resume_claimed_at", None)
            updated_resource = deepcopy(resource)
            updated_resource["resume_pending"] = False
            updated_resource["resumed_at"] = timestamp
            updated_resource.pop("resume_claim_id", None)
            updated_resource.pop("resume_claimed_at", None)
            updated_resource["updated_at"] = timestamp
            self._persist_resume_documents(
                approval_path,
                resource_path,
                approval,
                updated_resource,
                originals,
            )
            return self._submission_response(updated_resource)

    def consume_resume(self, review_id: str, *, conversation_id: str) -> dict[str, Any]:
        claim_id = f"consume:{uuid.uuid4()}"
        self.claim_resume(
            review_id,
            conversation_id=conversation_id,
            claim_id=claim_id,
        )
        return self.complete_resume(
            review_id,
            conversation_id=conversation_id,
            claim_id=claim_id,
        )


_store: CourseReviewStore | None = None
_store_lock = threading.Lock()


def get_course_review_store() -> CourseReviewStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = CourseReviewStore()
    return _store
