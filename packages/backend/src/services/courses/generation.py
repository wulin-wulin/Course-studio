"""Read-only progress snapshots for the v2 course-creation pipeline.

OpenCode writes intermediate artifacts outside the staged ``courses`` tree.
This module deliberately observes those files instead of parsing model text.
All readers are defensive: a file that is changing, malformed, or only partly
written is ignored until a later poll.
"""

from __future__ import annotations

import asyncio
import copy
from datetime import UTC, datetime
import json
import re
from pathlib import Path
import time
from typing import Any, Awaitable, Callable


_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_COMPONENT_RE = re.compile(r"^[A-Z][A-Za-z0-9]*$")
_MAX_JSON_BYTES = 64 * 1024 * 1024
_GATE_ORDER = {f"G{index}": index for index in range(8)}
_POINT_REQUIRED = {
    "id",
    "title",
    "shortSummary",
    "coreIdea",
    "principles",
    "keyTerms",
    "applications",
    "aliases",
    "intuition",
    "misconceptions",
    "qa",
    "animationType",
    "difficulty",
    "importance",
    "prerequisites",
}

JsonCache = dict[Path, tuple[int, int, dict[str, Any]]]
SnapshotSender = Callable[[dict[str, Any]], Awaitable[None]]

_STAGE_LABELS = {
    "G0": "正在确定课程范围",
    "G1": "正在规划知识点清单",
    "G2": "知识点清单已准备审核",
    "G3": "正在生成知识点内容",
    "G4": "正在生成教学动画",
    "G5": "正在校验课程内容",
    "G6": "知识图谱已准备审核",
    "G7": "课程已发布",
}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_id(value: Any) -> str:
    value = _text(value)
    return value if _ID_RE.fullmatch(value) else ""


def _safe_json_object(
    path: Path,
    cache: JsonCache | None = None,
    activity_mtimes: list[int] | None = None,
) -> dict[str, Any] | None:
    """Return one stable JSON object, or ``None`` while it is not usable."""

    try:
        if path.is_symlink() or not path.is_file():
            if cache is not None:
                cache.pop(path, None)
            return None
        before = path.stat()
        if before.st_size <= 1 or before.st_size > _MAX_JSON_BYTES:
            return None
        cache_key = (before.st_mtime_ns, before.st_size)
        cached = cache.get(path) if cache is not None else None
        if cached and cached[:2] == cache_key:
            if activity_mtimes is not None:
                activity_mtimes.append(before.st_mtime_ns)
            return cached[2]
        raw = path.read_bytes()
        after = path.stat()
        if (
            before.st_mtime_ns != after.st_mtime_ns
            or before.st_size != after.st_size
            or len(raw) != after.st_size
        ):
            return None
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    if activity_mtimes is not None:
        activity_mtimes.append(after.st_mtime_ns)
    if cache is not None:
        cache[path] = (after.st_mtime_ns, after.st_size, value)
    return value


def _pipeline_candidates(pipeline_root: Path) -> list[Path]:
    try:
        resolved_root = pipeline_root.resolve()
        entries = list(pipeline_root.iterdir()) if pipeline_root.is_dir() else []
    except OSError:
        return []
    candidates: list[tuple[int, Path]] = []
    for entry in entries:
        try:
            if entry.is_symlink() or not entry.is_dir() or not _ID_RE.fullmatch(entry.name):
                continue
            entry.resolve().relative_to(resolved_root)
            stamp = entry.stat().st_mtime_ns
            for relative in (
                "course-content/src/data/course.json",
                "course-content/src/data/index.json",
                "course-content/generation/manifest.json",
                "course-content/generation/animation-manifest.json",
                "clustered-graph.json",
            ):
                artifact = entry / relative
                if artifact.is_file() and not artifact.is_symlink():
                    stamp = max(stamp, artifact.stat().st_mtime_ns)
            candidates.append((stamp, entry))
        except (OSError, ValueError):
            continue
    return [entry for _, entry in sorted(candidates, key=lambda item: item[0], reverse=True)]


def _pipeline_from_hint(pipeline_root: Path, pipeline_hint: Path | None) -> Path | None:
    if pipeline_hint is None:
        return None
    try:
        if pipeline_hint.is_symlink():
            return None
        resolved_root = pipeline_root.resolve()
        resolved_hint = pipeline_hint.resolve()
        resolved_hint.relative_to(resolved_root)
        if (
            resolved_hint.parent != resolved_root
            or not resolved_hint.is_dir()
            or not _ID_RE.fullmatch(resolved_hint.name)
        ):
            return None
    except (OSError, ValueError):
        return None
    return resolved_hint


def _valid_course(value: dict[str, Any] | None, course_id: str) -> dict[str, Any] | None:
    if not value or value.get("schema_version") != "1.0":
        return None
    if _safe_id(value.get("id")) != course_id or not _text(value.get("title")):
        return None
    result: dict[str, Any] = {"id": course_id, "title": _text(value["title"])}
    description = _text(value.get("description"))
    if description:
        result["description"] = description
    return result


def _valid_index(value: dict[str, Any] | None, course_id: str) -> list[dict[str, Any]] | None:
    if (
        not value
        or value.get("schema_version") != "course-content-index/1.0"
        or _safe_id(value.get("courseId")) != course_id
        or not isinstance(value.get("points"), list)
        or not value["points"]
    ):
        return None
    points: list[dict[str, Any]] = []
    seen: set[str] = set()
    for order, item in enumerate(value["points"]):
        if not isinstance(item, dict):
            return None
        point_id = _safe_id(item.get("id"))
        title = _text(item.get("title"))
        if not point_id or point_id in seen or not title:
            return None
        importance = item.get("importance")
        if not isinstance(importance, (int, float)) or isinstance(importance, bool):
            importance = 0.5
        points.append({
            "id": point_id,
            "title": title,
            "order": order,
            "importance": max(0.0, min(1.0, float(importance))),
            "complete": False,
        })
        seen.add(point_id)
    return points


def _valid_generation_manifest(value: dict[str, Any] | None, points: list[dict[str, Any]]) -> bool:
    if (
        not value
        or value.get("schema_version") != "course-content-generation/1.0"
        or not isinstance(value.get("subject"), dict)
        or not isinstance(value.get("generation"), dict)
        or not isinstance(value.get("pointEvidence"), list)
        or not isinstance(value.get("reviewQueue"), list)
    ):
        return False
    evidence = value["pointEvidence"]
    return [item.get("pointId") for item in evidence if isinstance(item, dict)] == [
        item["id"] for item in points
    ]


def _valid_point(value: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    if not value or not _POINT_REQUIRED.issubset(value):
        return False
    if value.get("id") != expected["id"] or value.get("title") != expected["title"]:
        return False
    if len(_text(value.get("shortSummary"))) < 30 or not _text(value.get("coreIdea")):
        return False
    for field in (
        "principles",
        "keyTerms",
        "applications",
        "aliases",
        "misconceptions",
        "qa",
        "prerequisites",
    ):
        if not isinstance(value.get(field), list):
            return False
    if (
        len(value["principles"]) < 2
        or len(value["keyTerms"]) < 2
        or not value["applications"]
        or not value["misconceptions"]
        or not value["qa"]
        or not _text(value.get("intuition"))
        or not _text(value.get("animationType"))
        or not _text(value.get("difficulty"))
        or not isinstance(value.get("importance"), (int, float))
        or isinstance(value.get("importance"), bool)
    ):
        return False
    return all(
        isinstance(item, dict) and _text(item.get("q")) and _text(item.get("a"))
        for item in value["qa"]
    )


def _valid_animation_manifest(value: dict[str, Any] | None) -> list[str] | None:
    if (
        not value
        or value.get("schema_version") != "course-content-animations/1.0"
        or not isinstance(value.get("animations"), list)
    ):
        return None
    components: list[str] = []
    for item in value["animations"]:
        if not isinstance(item, dict):
            return None
        component = _text(item.get("component"))
        if (
            not _text(item.get("type"))
            or not component
            or not _COMPONENT_RE.fullmatch(component)
            or not isinstance(item.get("bindings"), list)
        ):
            return None
        components.append(component)
    return components


def _animation_progress(
    content_root: Path,
    components: list[str],
    activity_mtimes: list[int],
) -> tuple[int, bool]:
    registry_files = [
        content_root / "src/data/courseKnowledge.ts",
        content_root / "src/components/AnimationBlock.tsx",
        content_root / "src/components/AnimationBlock.css",
    ]
    registry_ready = True
    try:
        for path in registry_files:
            if path.is_symlink() or not path.is_file():
                registry_ready = False
                continue
            stat = path.stat()
            activity_mtimes.append(stat.st_mtime_ns)
            if stat.st_size <= 0:
                registry_ready = False

        completed = 0
        for component in components:
            component_ready = True
            for suffix in ("tsx", "css"):
                path = content_root / f"src/animations/{component}.{suffix}"
                if path.is_symlink() or not path.is_file():
                    component_ready = False
                    continue
                stat = path.stat()
                activity_mtimes.append(stat.st_mtime_ns)
                if stat.st_size <= 0:
                    component_ready = False
            if component_ready:
                completed += 1
        return completed, registry_ready and completed == len(components)
    except OSError:
        return 0, False


def _iso_from_ns(value: int | None) -> str | None:
    if not value:
        return None
    return datetime.fromtimestamp(value / 1_000_000_000, tz=UTC).isoformat().replace(
        "+00:00",
        "Z",
    )


def _snapshot_labels(snapshot: dict[str, Any]) -> None:
    gate = str(snapshot.get("gate") or "G0")
    point_completed = int(snapshot.get("point_completed") or 0)
    point_total = int(snapshot.get("point_total") or 0)
    animation_completed = int(snapshot.get("animation_completed") or 0)
    animation_total = int(snapshot.get("animation_total") or 0)
    snapshot["stage_label"] = _STAGE_LABELS.get(gate, "正在创建课程")

    if gate == "G3":
        detail = f"已完成 {point_completed}/{point_total} 个知识点"
        activity = f"知识点内容 {point_completed}/{point_total}"
    elif gate == "G4":
        detail = (
            f"已完成 {animation_completed}/{animation_total} 个动画"
            if animation_total
            else "正在生成无动画课程的注册文件"
        )
        activity = (
            f"教学动画 {animation_completed}/{animation_total}"
            if animation_total
            else "动画清单已确认"
        )
    elif gate in {"G5", "G6", "G7"}:
        detail = (
            f"{point_completed}/{point_total} 个知识点，"
            f"{animation_completed}/{animation_total} 个动画"
        )
        activity = snapshot["stage_label"]
    elif gate in {"G1", "G2"}:
        detail = f"已规划 {point_total} 个知识点"
        activity = snapshot["stage_label"]
    else:
        detail = "正在收集课程范围与目标"
        activity = snapshot["stage_label"]
    snapshot["stage_detail"] = detail
    snapshot["activity_label"] = activity


def _valid_graph(
    value: dict[str, Any] | None,
    course_id: str,
    indexed_points: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]] | None:
    if (
        not value
        or value.get("schema_version") != "clustered-graph/2.0"
        or not isinstance(value.get("subject"), dict)
        or _safe_id(value["subject"].get("id")) != course_id
        or not isinstance(value.get("generation"), dict)
        or _safe_id(value["generation"].get("sourceCourseId")) != course_id
        or value["generation"].get("pointCount") != len(indexed_points)
        or not isinstance(value.get("clusters"), list)
        or not value["clusters"]
        or not isinstance(value.get("points"), list)
    ):
        return None
    clusters: list[dict[str, Any]] = []
    cluster_ids: set[str] = set()
    for item in value["clusters"]:
        if not isinstance(item, dict):
            return None
        cluster_id = _safe_id(item.get("id"))
        title = _text(item.get("title"))
        subtitle = _text(item.get("subtitle"))
        description = _text(item.get("description"))
        order = item.get("order")
        if (
            not cluster_id
            or cluster_id in cluster_ids
            or not title
            or not subtitle
            or not description
            or not isinstance(order, int)
        ):
            return None
        cluster = {
            "id": cluster_id,
            "title": title,
            "subtitle": subtitle,
            "description": description,
            "order": order,
        }
        clusters.append(cluster)
        cluster_ids.add(cluster_id)

    graph_points = value["points"]
    if [item.get("id") for item in graph_points if isinstance(item, dict)] != [
        item["id"] for item in indexed_points
    ]:
        return None
    assignments: dict[str, str] = {}
    for item, expected in zip(graph_points, indexed_points, strict=True):
        if not isinstance(item, dict) or not _valid_point(item, expected):
            return None
        cluster_list = item.get("clusterIds")
        normalized_clusters = (
            [_safe_id(cluster_id) for cluster_id in cluster_list]
            if isinstance(cluster_list, list)
            else []
        )
        if (
            not normalized_clusters
            or not all(
                cluster_id and cluster_id in cluster_ids
                for cluster_id in normalized_clusters
            )
            or not _text(item.get("role"))
            or not isinstance(item.get("related"), list)
        ):
            return None
        assignments[item["id"]] = normalized_clusters[0]
    return sorted(clusters, key=lambda item: (item["order"], item["id"])), assignments


def build_course_generation_snapshot(
    pipeline_root: Path,
    conversation_id: str,
    *,
    published: bool = False,
    cache: JsonCache | None = None,
    pipeline_hint: Path | None = None,
) -> dict[str, Any]:
    """Build the best complete snapshot currently visible below ``pipeline``."""

    base: dict[str, Any] = {
        "conversation_id": conversation_id,
        "course": None,
        "gate": "G0",
        "total_points": 0,
        "points": [],
        "clusters": [],
        "published": False,
        "stage_label": _STAGE_LABELS["G0"],
        "stage_detail": "正在收集课程范围与目标",
        "activity_label": _STAGE_LABELS["G0"],
        "point_completed": 0,
        "point_total": 0,
        "animation_completed": 0,
        "animation_total": 0,
        "waiting_for": "none",
        "started_at": None,
        "last_activity_at": None,
    }
    hinted = _pipeline_from_hint(pipeline_root, pipeline_hint)
    candidates = [hinted] if hinted is not None else _pipeline_candidates(pipeline_root)
    if not candidates:
        return base

    pipeline = candidates[0]
    activity_mtimes: list[int] = []
    try:
        activity_mtimes.append(pipeline.stat().st_mtime_ns)
    except OSError:
        pass
    course_id = pipeline.name
    content_root = pipeline / "course-content"
    data_root = content_root / "src/data"
    course = _valid_course(
        _safe_json_object(data_root / "course.json", cache, activity_mtimes),
        course_id,
    )
    if course is None:
        if activity_mtimes:
            base["started_at"] = _iso_from_ns(min(activity_mtimes))
            base["last_activity_at"] = _iso_from_ns(max(activity_mtimes))
        return base
    base["course"] = course

    points = _valid_index(
        _safe_json_object(data_root / "index.json", cache, activity_mtimes),
        course_id,
    )
    if points is None:
        base["started_at"] = _iso_from_ns(min(activity_mtimes))
        base["last_activity_at"] = _iso_from_ns(max(activity_mtimes))
        return base
    base["gate"] = "G1"
    base["total_points"] = len(points)
    base["point_total"] = len(points)
    base["points"] = points

    manifest = _safe_json_object(
        content_root / "generation/manifest.json",
        cache,
        activity_mtimes,
    )
    if _valid_generation_manifest(manifest, points):
        base["gate"] = "G2"

    point_stage_started = False
    for point in points:
        detail_path = data_root / "points" / f"{point['id']}.json"
        try:
            point_stage_started = bool(
                point_stage_started
                or (detail_path.is_file() and not detail_path.is_symlink())
            )
        except OSError:
            pass
        detail = _safe_json_object(detail_path, cache, activity_mtimes)
        point["complete"] = _valid_point(detail, point)
    base["point_completed"] = sum(point["complete"] is True for point in points)
    # ``init-course-pipeline --stage points`` creates one ordinary placeholder
    # per indexed point immediately before content workers start. This is the
    # earliest reliable G3 signal and lets the UI predict progress for the very
    # first point instead of waiting until one full JSON file is already done.
    if point_stage_started:
        base["gate"] = "G3"

    animation_components = _valid_animation_manifest(
        _safe_json_object(
            content_root / "generation/animation-manifest.json",
            cache,
            activity_mtimes,
        )
    )
    if animation_components is not None:
        base["gate"] = "G4"
        base["animation_total"] = len(animation_components)
        animation_completed, registry_ready = _animation_progress(
            content_root,
            animation_components,
            activity_mtimes,
        )
        base["animation_completed"] = animation_completed
        if registry_ready:
            base["gate"] = "G5"

    graph = _valid_graph(
        _safe_json_object(
            pipeline / "clustered-graph.json",
            cache,
            activity_mtimes,
        ),
        course_id,
        points,
    )
    if graph is not None:
        clusters, assignments = graph
        for point in points:
            point["clusterId"] = assignments[point["id"]]
        base["clusters"] = clusters
        base["gate"] = "G6"

    if published and graph is not None:
        base["gate"] = "G7"
        base["published"] = True
    if activity_mtimes:
        base["started_at"] = _iso_from_ns(min(activity_mtimes))
        base["last_activity_at"] = _iso_from_ns(max(activity_mtimes))
    _snapshot_labels(base)
    return base


def _monotonic_snapshot(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
) -> dict[str, Any]:
    """Keep one course's observable progress from moving backwards.

    Files are written by external model workers. Even with stable stat checks,
    a writer can leave a syntactically incomplete file visible for one poll.
    The observer therefore retains its last-good state until a same-or-later
    complete snapshot arrives. A genuinely different course id starts a fresh
    progression.
    """

    if previous is None:
        return current
    if previous.get("published") is True:
        return copy.deepcopy(previous)

    previous_course = previous.get("course")
    current_course = current.get("course")
    previous_id = (
        previous_course.get("id")
        if isinstance(previous_course, dict)
        else ""
    )
    current_id = (
        current_course.get("id")
        if isinstance(current_course, dict)
        else ""
    )
    if previous_id and current_id and previous_id != current_id:
        return current
    if previous_id and not current_id:
        return copy.deepcopy(previous)

    previous_rank = _GATE_ORDER.get(str(previous.get("gate")), 0)
    current_rank = _GATE_ORDER.get(str(current.get("gate")), 0)
    if current_rank < previous_rank:
        return copy.deepcopy(previous)

    merged = copy.deepcopy(current)
    previous_started = previous.get("started_at")
    current_started = merged.get("started_at")
    if isinstance(previous_started, str) and (
        not isinstance(current_started, str) or previous_started < current_started
    ):
        merged["started_at"] = previous_started
    previous_activity = previous.get("last_activity_at")
    current_activity = merged.get("last_activity_at")
    if isinstance(previous_activity, str) and (
        not isinstance(current_activity, str) or previous_activity > current_activity
    ):
        merged["last_activity_at"] = previous_activity
    previous_points = previous.get("points")
    current_points = merged.get("points")
    if (
        previous_rank >= _GATE_ORDER["G3"]
        and isinstance(previous_points, list)
        and isinstance(current_points, list)
    ):
        previous_ids = [
            item.get("id") for item in previous_points if isinstance(item, dict)
        ]
        current_ids = [
            item.get("id") for item in current_points if isinstance(item, dict)
        ]
        if previous_ids != current_ids:
            return copy.deepcopy(previous)

    if isinstance(previous_points, list) and isinstance(current_points, list):
        completed_ids = {
            item.get("id")
            for item in previous_points
            if isinstance(item, dict) and item.get("complete") is True
        }
        for point in current_points:
            if isinstance(point, dict) and point.get("id") in completed_ids:
                point["complete"] = True
    return merged


class CourseGenerationObserver:
    """Poll a pipeline and emit full snapshots only when their content changes."""

    def __init__(
        self,
        pipeline_root: Path,
        conversation_id: str,
        *,
        interval_seconds: float = 0.75,
        heartbeat_seconds: float = 5.0,
    ) -> None:
        self.pipeline_root = pipeline_root
        self.conversation_id = conversation_id
        self.interval_seconds = interval_seconds
        self.heartbeat_seconds = max(interval_seconds, heartbeat_seconds)
        self._cache: JsonCache = {}
        self._last_signature: str | None = None
        self._last_snapshot: dict[str, Any] | None = None
        self._pipeline_hint: Path | None = None
        self._last_emit_monotonic: float | None = None
        self._phase_gate: str | None = None
        self._phase_started_monotonic = time.monotonic()
        self._observer_started_at = datetime.now(UTC).isoformat().replace(
            "+00:00",
            "Z",
        )
        self._recent_events: list[dict[str, Any]] = []
        self._waiting_for = "none"
        self._activity_override: str | None = None
        self._last_enriched_snapshot: dict[str, Any] | None = None

    def set_waiting_for(
        self,
        waiting_for: str,
        *,
        activity_label: str | None = None,
    ) -> None:
        self._waiting_for = waiting_for or "none"
        self._activity_override = activity_label

    def _add_telemetry(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        now = time.monotonic()
        gate = str(snapshot.get("gate") or "G0")
        if self._phase_gate is None:
            self._phase_gate = gate
            self._phase_started_monotonic = now
        elif gate != self._phase_gate:
            self._recent_events.append({
                "at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "kind": "stage_completed",
                "phase": self._phase_gate,
                "label": _STAGE_LABELS.get(self._phase_gate, self._phase_gate),
                "elapsed_ms": max(
                    0,
                    round((now - self._phase_started_monotonic) * 1000),
                ),
            })
            self._recent_events = self._recent_events[-8:]
            self._phase_gate = gate
            self._phase_started_monotonic = now

        enriched = copy.deepcopy(snapshot)
        enriched["phase_elapsed_ms"] = max(
            0,
            round((now - self._phase_started_monotonic) * 1000),
        )
        enriched["recent_events"] = copy.deepcopy(self._recent_events)
        enriched["waiting_for"] = self._waiting_for
        if self._activity_override:
            enriched["activity_label"] = self._activity_override
        if enriched.get("started_at") is None:
            enriched["started_at"] = self._observer_started_at
        return enriched

    @staticmethod
    def _stable_signature(snapshot: dict[str, Any]) -> str:
        stable = copy.deepcopy(snapshot)
        stable.pop("phase_elapsed_ms", None)
        return json.dumps(
            stable,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    async def emit_if_changed(
        self,
        send: SnapshotSender,
        *,
        published: bool = False,
        force: bool = False,
    ) -> dict[str, Any]:
        raw_snapshot = await asyncio.to_thread(
            build_course_generation_snapshot,
            self.pipeline_root,
            self.conversation_id,
            published=published,
            cache=self._cache,
            pipeline_hint=self._pipeline_hint,
        )
        snapshot = _monotonic_snapshot(self._last_snapshot, raw_snapshot)
        points = snapshot.get("points")
        if isinstance(points, list):
            snapshot["point_completed"] = sum(
                isinstance(point, dict) and point.get("complete") is True
                for point in points
            )
        _snapshot_labels(snapshot)
        self._last_snapshot = copy.deepcopy(snapshot)
        course = snapshot.get("course")
        if isinstance(course, dict) and _safe_id(course.get("id")):
            self._pipeline_hint = self.pipeline_root / course["id"]
        snapshot = self._add_telemetry(snapshot)
        signature = self._stable_signature(snapshot)
        now = time.monotonic()
        heartbeat_due = (
            self._last_emit_monotonic is not None
            and now - self._last_emit_monotonic >= self.heartbeat_seconds
        )
        if force or signature != self._last_signature or heartbeat_due:
            await send({"type": "course_generation_snapshot", "payload": snapshot})
            self._last_signature = signature
            self._last_emit_monotonic = now
            self._last_enriched_snapshot = copy.deepcopy(snapshot)
            return snapshot
        return copy.deepcopy(self._last_enriched_snapshot or snapshot)

    async def run(self, send: SnapshotSender) -> None:
        while True:
            await self.emit_if_changed(send)
            await asyncio.sleep(self.interval_seconds)
