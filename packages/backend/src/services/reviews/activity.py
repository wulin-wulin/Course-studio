"""Process-local activity leases for course-creation conversations."""

from __future__ import annotations

from dataclasses import dataclass
import threading
import time
from typing import Literal
import uuid


CourseActivityKind = Literal["agent-turn", "review-submit"]

_ACTIVITY_LABELS: dict[CourseActivityKind, str] = {
    "agent-turn": "OpenCode 课程创建任务",
    "review-submit": "课程审核提交",
}


def _safe_conversation_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(value))
    return cleaned[:80] or "default"


@dataclass(frozen=True, slots=True)
class CourseActivityLease:
    conversation_id: str
    kind: CourseActivityKind
    token: str
    claimed_at: float


class CourseActivityConflictError(RuntimeError):
    def __init__(
        self,
        requested_kind: CourseActivityKind,
        active_lease: CourseActivityLease,
    ) -> None:
        self.requested_kind = requested_kind
        self.active_lease = active_lease
        super().__init__(
            f"当前课程创建会话正在执行{_ACTIVITY_LABELS[active_lease.kind]}，"
            f"不能同时开始{_ACTIVITY_LABELS[requested_kind]}，请等待当前操作完成后重试。"
        )


class CourseActivityCoordinator:
    """Atomically grants at most one active operation per conversation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: dict[str, CourseActivityLease] = {}

    def claim(
        self,
        conversation_id: str,
        kind: CourseActivityKind,
    ) -> CourseActivityLease:
        safe_id = _safe_conversation_id(conversation_id)
        with self._lock:
            active = self._active.get(safe_id)
            if active is not None:
                raise CourseActivityConflictError(kind, active)
            lease = CourseActivityLease(
                conversation_id=safe_id,
                kind=kind,
                token=str(uuid.uuid4()),
                claimed_at=time.monotonic(),
            )
            self._active[safe_id] = lease
            return lease

    def release(self, lease: CourseActivityLease) -> bool:
        """Release only the matching lease so stale owners cannot unlock a successor."""

        with self._lock:
            active = self._active.get(lease.conversation_id)
            if active is None or active.token != lease.token:
                return False
            del self._active[lease.conversation_id]
            return True

    def active_for(self, conversation_id: str) -> CourseActivityLease | None:
        """Return a snapshot of the active lease for safe cleanup checks."""

        safe_id = _safe_conversation_id(conversation_id)
        with self._lock:
            return self._active.get(safe_id)


_coordinator = CourseActivityCoordinator()


def get_course_activity_coordinator() -> CourseActivityCoordinator:
    return _coordinator
