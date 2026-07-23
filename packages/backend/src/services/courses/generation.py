"""Read-only progress snapshots for the v2 course-creation pipeline.

OpenCode writes intermediate artifacts outside the staged ``courses`` tree.
This module deliberately observes those files instead of parsing model text.
All readers are defensive: a file that is changing, malformed, or only partly
written is ignored until a later poll.
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
from pathlib import Path
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


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_id(value: Any) -> str:
    value = _text(value)
    return value if _ID_RE.fullmatch(value) else ""


def _safe_json_object(path: Path, cache: JsonCache | None = None) -> dict[str, Any] | None:
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


def _animation_registry_ready(content_root: Path, components: list[str]) -> bool:
    required = [
        content_root / "src/data/courseKnowledge.ts",
        content_root / "src/components/AnimationBlock.tsx",
        content_root / "src/components/AnimationBlock.css",
    ]
    for component in components:
        required.extend([
            content_root / f"src/animations/{component}.tsx",
            content_root / f"src/animations/{component}.css",
        ])
    try:
        return all(path.is_file() and not path.is_symlink() and path.stat().st_size > 0 for path in required)
    except OSError:
        return False


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
    }
    candidates = _pipeline_candidates(pipeline_root)
    if not candidates:
        return base

    pipeline = candidates[0]
    course_id = pipeline.name
    content_root = pipeline / "course-content"
    data_root = content_root / "src/data"
    course = _valid_course(_safe_json_object(data_root / "course.json", cache), course_id)
    if course is None:
        return base
    base["course"] = course

    points = _valid_index(_safe_json_object(data_root / "index.json", cache), course_id)
    if points is None:
        return base
    base["gate"] = "G1"
    base["total_points"] = len(points)
    base["points"] = points

    manifest = _safe_json_object(content_root / "generation/manifest.json", cache)
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
        detail = _safe_json_object(detail_path, cache)
        point["complete"] = _valid_point(detail, point)
    # ``init-course-pipeline --stage points`` creates one ordinary placeholder
    # per indexed point immediately before content workers start. This is the
    # earliest reliable G3 signal and lets the UI predict progress for the very
    # first point instead of waiting until one full JSON file is already done.
    if point_stage_started:
        base["gate"] = "G3"

    animation_components = _valid_animation_manifest(
        _safe_json_object(content_root / "generation/animation-manifest.json", cache)
    )
    if animation_components is not None:
        base["gate"] = "G4"
        if _animation_registry_ready(content_root, animation_components):
            base["gate"] = "G5"

    graph = _valid_graph(
        _safe_json_object(pipeline / "clustered-graph.json", cache),
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
    ) -> None:
        self.pipeline_root = pipeline_root
        self.conversation_id = conversation_id
        self.interval_seconds = interval_seconds
        self._cache: JsonCache = {}
        self._last_signature: str | None = None
        self._last_snapshot: dict[str, Any] | None = None

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
        )
        snapshot = _monotonic_snapshot(self._last_snapshot, raw_snapshot)
        self._last_snapshot = copy.deepcopy(snapshot)
        signature = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if force or signature != self._last_signature:
            await send({"type": "course_generation_snapshot", "payload": snapshot})
            self._last_signature = signature
        return snapshot

    async def run(self, send: SnapshotSender) -> None:
        while True:
            await self.emit_if_changed(send)
            await asyncio.sleep(self.interval_seconds)
