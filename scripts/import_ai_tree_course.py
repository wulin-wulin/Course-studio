#!/usr/bin/env python3
"""Import the AI Tree Course data into this repository's canonical catalog.

The source project is treated as read-only.  This script copies its published
``src/data/index.json`` and ``src/data/points/*.json`` files into the CKDS
course-package layout used by this repository:

    course-data/courses/ai-principles/
      course.json
      index.json
      points/<point-id>.json

Run this only to seed or explicitly refresh the bundled course.  It refuses to
overwrite an existing package unless ``--force`` is supplied, so Agent edits to
the canonical catalog are not accidentally replaced by a later import.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"D:\Project\AI_tree_course")
COURSE_ID = "ai-principles"

INDEX_META_FIELDS = (
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(os.environ.get("AI_TREE_COURSE_SOURCE", DEFAULT_SOURCE)),
        help="AI_tree_course project root (default: %(default)s)",
    )
    parser.add_argument(
        "--destination",
        type=Path,
        default=ROOT / "course-data" / "courses" / COURSE_ID,
        help="destination course-package directory (default: %(default)s)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing destination package after a complete staged import",
    )
    return parser.parse_args()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing required file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def inspect_package(package_dir: Path) -> tuple[int, int, list[str]]:
    """Validate package structure and report legacy-data compatibility notes.

    The source course is a published visualization asset.  In particular, a
    small number of its detail summaries and prerequisite labels predate the
    newer CKDS identifiers.  Those are reported, never rewritten here: a raw
    import must preserve the original course's rendering data exactly.
    """
    course = read_json(package_dir / "course.json")
    index = read_json(package_dir / "index.json")
    if course.get("id") != COURSE_ID:
        raise ValueError(f"course.json id must be {COURSE_ID!r}")

    clusters = index.get("clusters")
    points = index.get("points")
    if not isinstance(clusters, list) or not isinstance(points, list):
        raise ValueError("index.json must contain list-valued clusters and points")

    cluster_ids = [cluster.get("id") for cluster in clusters if isinstance(cluster, dict)]
    if len(cluster_ids) != len(clusters) or any(not value for value in cluster_ids):
        raise ValueError("every cluster must have a non-empty id")
    if len(set(cluster_ids)) != len(cluster_ids):
        raise ValueError("cluster ids must be unique")
    cluster_id_set = set(cluster_ids)

    index_by_id: dict[str, dict[str, Any]] = {}
    for meta in points:
        if not isinstance(meta, dict):
            raise ValueError("every index point must be an object")
        point_id = meta.get("id")
        if not isinstance(point_id, str) or not point_id:
            raise ValueError("every index point must have a non-empty id")
        if point_id in index_by_id:
            raise ValueError(f"duplicate point id in index: {point_id}")
        if meta.get("clusterId") not in cluster_id_set:
            raise ValueError(f"point {point_id} references an unknown cluster")
        missing = [field for field in INDEX_META_FIELDS if field not in meta]
        if missing:
            raise ValueError(f"index point {point_id} is missing fields: {', '.join(missing)}")
        index_by_id[point_id] = meta

    points_dir = package_dir / "points"
    point_files = {path.stem: path for path in points_dir.glob("*.json")}
    if set(index_by_id) != set(point_files):
        missing_files = sorted(set(index_by_id) - set(point_files))
        extra_files = sorted(set(point_files) - set(index_by_id))
        details: list[str] = []
        if missing_files:
            details.append(f"missing detail files: {', '.join(missing_files[:5])}")
        if extra_files:
            details.append(f"unindexed detail files: {', '.join(extra_files[:5])}")
        raise ValueError("index/detail mismatch (" + "; ".join(details) + ")")

    point_ids = set(index_by_id)
    metadata_mismatches = 0
    unknown_prerequisites: list[str] = []
    invalid_prerequisite_fields: list[str] = []
    duplicate_or_self_prerequisites: list[str] = []
    for point_id, path in point_files.items():
        detail = read_json(path)
        if detail.get("id") != point_id:
            raise ValueError(f"{path.name} id does not match its filename")
        for field in INDEX_META_FIELDS:
            if detail.get(field) != index_by_id[point_id].get(field):
                metadata_mismatches += 1
        prereqs = detail.get("prerequisites", [])
        if not isinstance(prereqs, list) or not all(isinstance(item, str) for item in prereqs):
            invalid_prerequisite_fields.append(path.name)
            continue
        if point_id in prereqs or len(prereqs) != len(set(prereqs)):
            duplicate_or_self_prerequisites.append(path.name)
        unknown = sorted(set(prereqs) - point_ids)
        if unknown:
            unknown_prerequisites.append(f"{path.name}: {', '.join(unknown[:3])}")

    notes: list[str] = []
    if metadata_mismatches:
        notes.append(
            f"{metadata_mismatches} duplicated index/detail metadata fields differ "
            "in the source (preserved unchanged)"
        )
    if unknown_prerequisites:
        notes.append(
            f"{len(unknown_prerequisites)} points use legacy prerequisite labels "
            f"instead of point IDs (example: {unknown_prerequisites[0]})"
        )
    if invalid_prerequisite_fields:
        notes.append(
            f"{len(invalid_prerequisite_fields)} points have a non-array prerequisites field"
        )
    if duplicate_or_self_prerequisites:
        notes.append(
            f"{len(duplicate_or_self_prerequisites)} points have duplicate or self prerequisites"
        )
    return len(clusters), len(points), notes


def build_staging_package(source_root: Path, stage_dir: Path) -> None:
    source_data = source_root / "src" / "data"
    source_index = source_data / "index.json"
    # Parse once to give a useful error before copying, but copy the bytes
    # unchanged below so the forest stays exactly as authored.
    read_json(source_index)
    source_points = source_data / "points"
    if not source_points.is_dir():
        raise ValueError(f"missing source points directory: {source_points}")

    stage_dir.mkdir(parents=True)
    shutil.copy2(source_index, stage_dir / "index.json")
    write_json(
        stage_dir / "course.json",
        {
            "schema_version": "1.0",
            "id": COURSE_ID,
            "title": "人工智能原理",
            "subtitle": "AI 知识森林",
            "description": "面向人工智能原理课程的交互式知识森林。课程数据由课程内容管理员维护，可供课程 Agent 读取和编辑。",
            "revision": 1,
        },
    )
    shutil.copytree(source_points, stage_dir / "points", copy_function=shutil.copy2)


def replace_package(stage_dir: Path, destination: Path, force: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        stage_dir.replace(destination)
        return
    if not force:
        raise ValueError(
            f"destination already exists: {destination}. Re-run with --force only "
            "when replacing the current canonical course package is intentional."
        )

    backup = destination.with_name(f".{destination.name}.backup-{uuid.uuid4().hex}")
    destination.replace(backup)
    try:
        stage_dir.replace(destination)
    except Exception:
        backup.replace(destination)
        raise
    shutil.rmtree(backup)


def main() -> int:
    args = parse_args()
    source = args.source.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    stage_dir = destination.parent / f".{destination.name}.import-{uuid.uuid4().hex}"

    try:
        build_staging_package(source, stage_dir)
        clusters, points, notes = inspect_package(stage_dir)
        replace_package(stage_dir, destination, args.force)
    except (OSError, ValueError) as exc:
        shutil.rmtree(stage_dir, ignore_errors=True)
        print(f"Course import failed: {exc}", file=sys.stderr)
        return 1

    print(f"Imported {points} knowledge points across {clusters} clusters into {destination}")
    for note in notes:
        print(f"Compatibility note: {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
