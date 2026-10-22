"""Publish the small MinerU-style Markdown fixture as a deterministic course.

This utility is intentionally local and deterministic. It reads the checked-in
fixture, verifies its content hash, derives the four textbook points through the
real Markdown parser, and writes a canonical course package without calling an
LLM or any network service.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "packages" / "backend"
FIXTURE = BACKEND_ROOT / "tests" / "fixtures" / "mineru" / "small" / "full.md"
COURSE_ID = "sensor-data-validation-markdown-fixture"
COURSE_CATALOG_ROOT = PROJECT_ROOT / "course-data" / "courses"
COURSE_ROOT = COURSE_CATALOG_ROOT / COURSE_ID
EXPECTED_SHA256 = "cca042f6cb00b36a4334cfc38e17be345fe3ae5bb118810be5a96e36adec7061"
DOCUMENT_ID = "mineru-small-fixture"


POINT_CONTENT: dict[str, dict[str, Any]] = {
    "point-1-1": {
        "shortSummary": "理解采样间隔、采样频率与设备时间戳，识别网络抖动造成的到达时间偏差。",
        "difficulty": "基础",
        "importance": 0.92,
        "keyTerms": ["采样间隔", "时间戳", "采样频率", "网络抖动"],
        "coreIdea": "采样间隔 Δt 是相邻观测的设备时间戳之差，采样频率满足 f_s=1/Δt。判断采样是否连续，应检查设备采集时间，不能把服务器接收时间或文件行数直接当作采样依据。",
        "principles": [
            "统一时间戳的时区，并同时保留原始时间和校正时间。",
            "用相邻设备时间戳之差判断遗漏记录和采样抖动。",
            "将允许的抖动范围写入可追溯配置，再据此判断采样质量。",
        ],
        "applications": [
            "验证物联网温度传感器是否按五秒周期稳定采样。",
            "区分设备采集延迟与网络传输延迟。",
        ],
        "intuition": "设备时间戳像相机的快门时刻，服务器接收时间像照片送到相册的时刻；网络拥堵会推迟送达，却不会改变真正的拍摄时刻。",
        "misconceptions": [
            "只统计文件行数就判断没有漏采，而不检查时间戳间隔。",
            "把服务器接收时间当作设备采样时间，忽略网络抖动。",
        ],
        "qa": [
            {"q": "每五秒采样一次时理论采样频率是多少？", "a": "Δt=5 秒，因此 f_s=1/5=0.2 Hz。"},
            {"q": "为什么要保留设备时间戳？", "a": "它反映真实采集时刻，可用于识别漏采和抖动，并与网络到达延迟区分。"},
        ],
        "prerequisites": [],
        "kind": "concept",
    },
    "point-1-2": {
        "shortSummary": "区分缺失值与异常值，并按照量程、变化规律和边界约定选择处理策略。",
        "difficulty": "基础",
        "importance": 0.94,
        "keyTerms": ["缺失值", "异常值", "量程", "边界检查"],
        "coreIdea": "缺失值表示应有的观测没有获得，异常值则是已经获得但违反物理范围或变化规律的读数。两者成因和风险不同，应分别标记、复核和处理，不能统一替换为零。",
        "principles": [
            "缺失记录应保留缺失标记，并依据业务需要评估是否插值。",
            "越界或突变记录应先隔离，再结合设备量程和邻近记录复核。",
            "量程端点是否有效取决于开区间或闭区间约定，规则必须进入配置。",
        ],
        "applications": [
            "清洗存在断点、310℃ 越界值和一分钟突升 35℃ 的温度序列。",
            "为告警算法建立可追溯的数据质量标记。",
        ],
        "intuition": "缺失值像表格里空着的格子，异常值像格子里写了一个不可能的数；前者需要补齐或注明，后者需要查明来源。",
        "misconceptions": [
            "把所有可疑数据直接改成零，导致零值和缺失语义混淆。",
            "脱离传感器量程和业务规则设置统一异常阈值。",
        ],
        "qa": [
            {"q": "缺失值和异常值的关键区别是什么？", "a": "缺失值没有有效观测，异常值有观测但违反已知范围或变化规律。"},
            {"q": "量程上限值一定有效吗？", "a": "不一定，取决于规则采用闭区间还是开区间，必须以明确配置为准。"},
        ],
        "prerequisites": ["point-1-1"],
        "kind": "concept",
    },
    "point-2-1": {
        "shortSummary": "使用移动平均削弱短时噪声，同时权衡窗口大小、响应延迟和缺失值处理。",
        "difficulty": "中等",
        "importance": 0.88,
        "keyTerms": ["移动平均", "窗口宽度", "噪声", "响应延迟"],
        "coreIdea": "移动平均以最近 w 个有效观测的平均值表示当前趋势。窗口越大，曲线越平滑，但对真实变化的响应也越慢；遇到缺失值时，还必须明确分母采用固定窗口宽度还是有效观测数量。",
        "principles": [
            "窗口宽度决定降噪强度与响应速度之间的权衡。",
            "缺失值参与方式必须明确，避免分母含义随实现变化。",
            "平滑结果用于观察趋势，原始读数和质量标记仍需保留。",
        ],
        "applications": [
            "对温度、湿度和振动读数做短窗口平滑。",
            "在告警判断前减少随机噪声造成的瞬时越界。",
        ],
        "intuition": "移动平均像用一把短尺沿曲线滑动，每次用尺子覆盖范围内的平均高度代替当前尖峰。尺子越长越平稳，也越难及时跟上转折。",
        "misconceptions": [
            "认为窗口越大结果一定越好，忽略响应延迟。",
            "用平滑值覆盖原始数据，导致故障诊断时无法回查。",
        ],
        "qa": [
            {"q": "增大窗口宽度会带来什么影响？", "a": "通常会增强平滑效果，同时增加对真实变化的响应延迟。"},
            {"q": "为什么不能删除原始读数？", "a": "平滑会改变局部波动，诊断设备故障时仍需回查原始值和质量标记。"},
        ],
        "prerequisites": ["point-1-2"],
        "kind": "method",
    },
    "point-2-2": {
        "shortSummary": "用进入阈值和退出阈值构成迟滞区，避免告警在单一阈值附近频繁切换。",
        "difficulty": "中等",
        "importance": 0.95,
        "keyTerms": ["阈值", "迟滞", "状态机", "边界条件"],
        "coreIdea": "迟滞告警维护正常或告警状态，并为进入和退出设置不同阈值。示例规则在读数高于 80 时进入告警，只有低于 75 才解除，从而让 75 到 80 之间成为稳定的缓冲区。",
        "principles": [
            "当前状态是下一次判断的输入，告警逻辑不能只看当前数值。",
            "进入阈值应高于退出阈值，以形成阻止反复开关的缓冲区。",
            "等于 80 或 75 时的行为取决于比较符号，边界用例必须单独测试。",
        ],
        "applications": [
            "减少温度读数在告警线附近波动造成的通知风暴。",
            "为压力、液位和电流监测实现可复核的双阈值状态机。",
        ],
        "intuition": "迟滞像空调的启停温差：温度升到较高门槛才启动，降到较低门槛才停止，中间区域保持原有状态。",
        "misconceptions": [
            "使用同一个阈值进入和退出告警，导致状态频繁抖动。",
            "忽略等于阈值时的分支，使不同实现产生不同结果。",
        ],
        "qa": [
            {"q": "读数从 82 降到 78 时会解除告警吗？", "a": "不会；示例规则要求读数低于 75 才解除，78 位于迟滞区内。"},
            {"q": "读数恰好等于 80 时会进入告警吗？", "a": "不会；教材示例使用 value > 80，等于 80 时保持正常。"},
        ],
        "prerequisites": ["point-2-1"],
        "kind": "algorithm",
    },
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def assert_course_target(path: Path) -> None:
    """Refuse to replace anything outside the canonical course catalog."""

    catalog_root = COURSE_CATALOG_ROOT.resolve()
    resolved = path.resolve()
    if resolved.parent != catalog_root:
        raise RuntimeError(f"refusing to replace course path outside {catalog_root}: {resolved}")


def source_span(section: dict[str, Any]) -> dict[str, Any]:
    return {
        "materialId": DOCUMENT_ID,
        "blockIds": [section["id"]],
        "headingPath": section["heading_path"],
        "lineStart": section["line_start"],
        "lineEnd": section["line_end"],
        "assetRefs": section["asset_refs"],
        "excerptSha256": section["sha256"],
    }


def build_package() -> None:
    sys.path.insert(0, str(BACKEND_ROOT))
    from src.services.documents.markdown_parser import build_markdown_artifacts

    markdown_bytes = FIXTURE.read_bytes()
    fixture_sha = hashlib.sha256(markdown_bytes).hexdigest()
    if fixture_sha != EXPECTED_SHA256:
        raise RuntimeError(
            "small Markdown fixture changed; review the deterministic course content "
            f"before updating EXPECTED_SHA256 (actual {fixture_sha})"
        )
    outline, material = build_markdown_artifacts(
        markdown_bytes.decode("utf-8"),
        document_id=DOCUMENT_ID,
        filename=FIXTURE.name,
        sha256=fixture_sha,
    )
    flattened = [
        (chapter, point)
        for chapter in outline["chapters"]
        for point in chapter["points"]
    ]
    if [point["id"] for _, point in flattened] != list(POINT_CONTENT):
        raise RuntimeError("small fixture no longer contains the expected four textbook points")

    sections = {section["id"]: section for section in material["sections"]}
    point_sources = {
        item["point_id"]: item for item in material["point_sources"]
    }
    course = {
        "schema_version": "1.0",
        "id": COURSE_ID,
        "title": f"{outline['title']}（Markdown 链路测试）",
        "description": "由仓库中的 MinerU 风格 small Markdown 教材确定性生成，用于检查教材证据、知识森林和学习顺序展示。",
        "language": "zh-CN",
        "version": "0.1.0",
        "updatedAt": "2026-10-22",
        "subtitle": "采样质量、数据清洗、移动平均与迟滞告警。",
        "accent": "#2F7A65",
        "route": f"/courses/{COURSE_ID}",
        "revision": f"fixture-{fixture_sha[:12]}",
        "status": "published",
        "source": {
            "type": "markdown-fixture",
            "path": "packages/backend/tests/fixtures/mineru/small/full.md",
            "sha256": fixture_sha,
            "parser": "markdown-import",
        },
    }
    clusters = []
    for chapter in outline["chapters"]:
        clusters.append({
            "id": chapter["id"],
            "title": chapter["title"],
            "subtitle": (
                "可靠采样与数据清洗"
                if chapter["id"] == "chapter-1"
                else "从降噪到稳定告警"
            ),
            "description": (
                "按照教材顺序理解时间基准，区分缺失与异常，并建立可追溯的数据质量规则。"
                if chapter["id"] == "chapter-1"
                else "在保留原始数据的前提下平滑短时噪声，并用迟滞状态避免告警抖动。"
            ),
            "order": chapter["order"],
            "accent": "#2F7A65" if chapter["id"] == "chapter-1" else "#A86132",
            "soft": "#E2F4EC" if chapter["id"] == "chapter-1" else "#F8E8DA",
            "dark": "#185342" if chapter["id"] == "chapter-1" else "#6E381C",
        })

    index_points: list[dict[str, Any]] = []
    details: dict[str, dict[str, Any]] = {}
    for chapter, point in flattened:
        content = POINT_CONTENT[point["id"]]
        source = point_sources[point["id"]]
        matching = next(
            sections[section_id]
            for section_id in source["section_ids"]
            if sections[section_id]["title"] == point["title"]
        )
        role = "trunk" if point["order"] == 0 else "leaf"
        related = []
        metadata = {
            "id": point["id"],
            "title": point["title"],
            "clusterId": chapter["id"],
            "clusterIds": [chapter["id"]],
            "role": role,
            "related": related,
            "shortSummary": content["shortSummary"],
            "difficulty": content["difficulty"],
            "importance": content["importance"],
            "keyTerms": content["keyTerms"],
            "origin": "textbook",
            "pos": [0, 0],
            "scale": 1,
        }
        index_points.append(metadata)
        details[point["id"]] = {
            **deepcopy(metadata),
            "subtitle": chapter["title"],
            "kind": content["kind"],
            "coreIdea": content["coreIdea"],
            "principles": content["principles"],
            "applications": content["applications"],
            "aliases": [],
            "intuition": content["intuition"],
            "misconceptions": content["misconceptions"],
            "qa": content["qa"],
            "animationType": "none",
            "prerequisites": content["prerequisites"],
            "sourceSpans": [source_span(matching)],
            "modelEnriched": True,
        }

    index = {
        "schema_version": "1.0",
        "courseId": COURSE_ID,
        "generatedAt": "2026-10-22",
        "clusters": clusters,
        "points": index_points,
        "sequences": {
            "cluster": [{"fromId": "chapter-1", "toId": "chapter-2"}],
            "point": [
                {"fromId": "point-1-1", "toId": "point-1-2"},
                {"fromId": "point-1-2", "toId": "point-2-1"},
                {"fromId": "point-2-1", "toId": "point-2-2"},
            ],
        },
    }

    temporary = COURSE_ROOT.with_name(f".{COURSE_ID}.building")
    assert_course_target(temporary)
    assert_course_target(COURSE_ROOT)
    if temporary.exists():
        shutil.rmtree(temporary)
    write_json(temporary / "course.json", course)
    write_json(temporary / "index.json", index)
    for point_id, detail in details.items():
        write_json(temporary / "points" / f"{point_id}.json", detail)
    if COURSE_ROOT.exists():
        shutil.rmtree(COURSE_ROOT)
    temporary.rename(COURSE_ROOT)

    subprocess.run(
        [
            "node",
            str(PROJECT_ROOT / "scripts" / "layout-course-map.mjs"),
            COURSE_ID,
            "--seed",
            "mineru-small-fixture-v1",
            "--apply",
        ],
        cwd=PROJECT_ROOT,
        check=True,
    )


if __name__ == "__main__":
    build_package()
    print(f"Published deterministic fixture course: course-data/courses/{COURSE_ID}")
