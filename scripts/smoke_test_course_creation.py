#!/usr/bin/env python3
"""Run the real WebSocket/OpenCode course-creation flow and clean up afterward."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import uuid

import httpx
import websockets


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SESSION_ROOT = (
    PROJECT_ROOT / "packages" / "backend" / "generated" / "course_agent_sessions"
)


async def run_turn(
    websocket: websockets.ClientConnection,
    *,
    conversation_id: str,
    message: str = "",
    review_resume_id: str | None = None,
    model: str | None,
    api_url: str,
    timeout: float,
) -> tuple[str, int, dict | None]:
    payload = {
        "conversation_id": conversation_id,
        "message": message,
        "images": [],
        "mode": "agent",
        "workflow": "course-create",
    }
    if review_resume_id:
        payload["review_resume_id"] = review_resume_id
    if model:
        payload["model"] = model
    await websocket.send(json.dumps({"type": "agent_request", "payload": payload}))

    chunks: list[str] = []
    question_events = 0
    review: dict | None = None
    while True:
        raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        event = json.loads(raw)
        event_type = event.get("type")
        event_payload = event.get("payload") or {}
        if event_type == "agent_text_delta":
            chunks.append(str(event_payload.get("text") or ""))
        elif event_type == "agent_status":
            label = event_payload.get("label")
            if label:
                print(f"  status: {label}")
        elif event_type == "agent_question":
            question_events += 1
            questions = event_payload.get("questions") or []
            request_id = str(event_payload.get("request_id") or "")
            answers = choose_question_answers(questions)
            labels = ["、".join(answer) for answer in answers]
            print(f"  question: {request_id} -> {' | '.join(labels)}")
            async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                response = await client.post(
                    f"{api_url.rstrip('/')}/agent/questions/{request_id}/reply",
                    json={"conversation_id": conversation_id, "answers": answers},
                )
                response.raise_for_status()
        elif event_type == "agent_review_required":
            if review is not None:
                raise RuntimeError("one agent turn emitted more than one review gate")
            review = dict(event_payload)
            print(
                "  review: "
                f"{review.get('kind')} / {review.get('gate')} / {review.get('id')}"
            )
        elif event_type == "agent_review_resolved":
            print(
                "  review resumed: "
                f"{event_payload.get('kind')} / {event_payload.get('id')}"
            )
        elif event_type == "agent_error":
            raise RuntimeError(str(event_payload.get("message") or "Agent error"))
        elif event_type == "agent_done":
            if int(event_payload.get("return_code") or 0) != 0:
                raise RuntimeError(f"Agent exited with {event_payload.get('return_code')}")
            awaiting_review = bool(event_payload.get("awaiting_review"))
            if awaiting_review != (review is not None):
                raise RuntimeError(
                    "agent_done.awaiting_review does not match agent_review_required"
                )
            return "".join(chunks).strip(), question_events, review


async def approve_review(
    *,
    api_url: str,
    conversation_id: str,
    review: dict,
) -> dict:
    review_id = str(review.get("id") or "")
    if not review_id:
        raise RuntimeError("agent_review_required omitted review id")
    base_url = f"{api_url.rstrip('/')}/agent/reviews"
    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
        detail_response = await client.get(f"{base_url}/{review_id}")
        detail_response.raise_for_status()
        detail = detail_response.json()
        if detail.get("conversation_id") != conversation_id:
            raise RuntimeError("review detail belongs to another conversation")
        if (
            detail.get("kind") != review.get("kind")
            or detail.get("gate") != review.get("gate")
        ):
            raise RuntimeError("review pointer and detail disagree")
        submit_response = await client.post(
            f"{base_url}/{review_id}/submit",
            json={
                "conversation_id": conversation_id,
                "revision": detail.get("revision"),
                "artifact_hash": detail.get("artifact_hash"),
                "operations": [],
            },
        )
        submit_response.raise_for_status()
        submitted = submit_response.json()
    submitted_review = submitted.get("review") or {}
    if (
        submitted.get("ok") is not True
        or submitted_review.get("id") != review_id
        or submitted_review.get("status") != "resolved"
        or submitted_review.get("resume_pending") is not True
    ):
        raise RuntimeError(f"review {review_id} was not resolved for resume")
    print(f"  review approved with no edits: {review_id}")
    return submitted_review


def choose_question_answers(questions: list[dict]) -> list[list[str]]:
    answers: list[list[str]] = []
    for question in questions:
        prompt = f"{question.get('header', '')} {question.get('question', '')}"
        options = question.get("options") if isinstance(question.get("options"), list) else []
        labels = [
            str(option.get("label") or "").strip()
            for option in options
            if isinstance(option, dict) and str(option.get("label") or "").strip()
        ]
        positive = next(
            (
                label
                for label in labels
                if any(word in label for word in ("确认发布", "确认通过", "接受", "通过", "继续", "推荐"))
                and not any(word in label for word in ("不发布", "暂不", "拒绝", "修改"))
            ),
            None,
        )
        if positive:
            answers.append([positive])
        elif "受众" in prompt or "学习者" in prompt:
            answers.append(["具备基础开发经验的软件工程初学者"])
        elif "深度" in prompt or "时长" in prompt:
            answers.append(["两小时入门"])
        elif "范围" in prompt:
            answers.append(["仅覆盖十个软件工程文档静态元数据字段的定义与填写边界"])
        else:
            safe = next(
                (
                    label
                    for label in labels
                    if not any(word in label for word in ("暂不", "拒绝", "取消", "修改"))
                ),
                None,
            )
            answers.append([safe or "按当前建议继续"])
    return answers


def load_artifact(path: Path, expected_schema: str) -> dict:
    if not path.is_file():
        raise RuntimeError(f"missing artifact: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != expected_schema:
        raise RuntimeError(
            f"bad schema in {path.name}: {data.get('schema_version')!r}"
        )
    return data


async def main_async(args: argparse.Namespace) -> int:
    suffix = uuid.uuid4().hex[:8]
    course_id = f"course-creation-smoke-{suffix}"
    conversation_id = f"course-creation-smoke-{uuid.uuid4()}"
    session_root = Path(args.session_root).resolve() / conversation_id
    pipeline_root = session_root / "pipeline" / course_id
    content_root = pipeline_root / "course-content"
    course_path = content_root / "src" / "data" / "course.json"
    index_path = content_root / "src" / "data" / "index.json"
    generation_path = content_root / "generation" / "manifest.json"
    animation_manifest_path = (
        content_root / "generation" / "animation-manifest.json"
    )
    points_root = content_root / "src" / "data" / "points"
    requests_root = content_root / "generation" / "animation-requests"
    graph_path = pipeline_root / "clustered-graph.json"
    published = False

    print(f"conversation_id={conversation_id}")
    print(f"course_id={course_id}")
    async with websockets.connect(
        args.ws_url,
        max_size=16 * 1024 * 1024,
        proxy=None,
    ) as websocket:
        initial_message = (
            f"创建一门《软件工程文档元数据字段词典（v2 全流程测试）》课程，course-id 必须使用 {course_id}。"
            "使用 full 和 model-only 模式，面向具备基础开发经验的软件工程初学者，深度为两小时入门。"
            "课程只讲文档上静态记录的元数据字段，知识点必须恰好为：文档标题、文档唯一标识、文档版本号、"
            "文档作者、文档所有者、文档适用范围、文档语言、文档密级、文档关键词、文档参考资料。"
            "排除文档创建、修改、审批、发布、流转等过程，排除运行时交互、状态变化、算法执行、时间线演进、"
            "工具操作和特定厂商格式。严格依次完成 G0_SCOPE 到 G7_RELEASE_READY，并把内容写入 v2 "
            "course-content 包、把图写入其同级 clustered-graph.json。G1 通过后创建 "
            "knowledge-points/G2_IDENTITY_REVIEW 结构化审核并停止；审核恢复后再进入 G3。"
            "正文和动画生成阶段不创建 question 人工审核或人工验收凭据，但仍须执行完整内容校验、"
            "动画源码校验和真实生产构建。动画请求必须对每个知识点按真实动态机制逐点判断："
            "虽然本课程被限定为静态概念辨析，但不得为了让测试通过而预设 animationType=none、"
            "隐藏真实动画需要或绕过动画契约；若确实发现动态机制，应如实生成，让测试断言暴露预期偏差。"
            "图谱完成后创建 knowledge-graph/G6_GRAPH_REVIEW 结构化审核并停止；审核恢复后进入 G7。"
            "G7 的全部校验通过后，必须使用 question 工具询问是否发布，得到确认后才执行项目发布。"
        )
        expected_reviews = [
            ("knowledge-points", "G2_IDENTITY_REVIEW"),
            ("knowledge-graph", "G6_GRAPH_REVIEW"),
        ]
        resolved_reviews: list[tuple[str, str]] = []
        resume_id: str | None = None
        final_question_events = 0
        for turn_number in range(1, 4):
            print(
                f"turn {turn_number}/3: "
                + ("create outline" if turn_number == 1 else f"resume {resume_id}")
            )
            text, question_events, review = await run_turn(
                websocket,
                conversation_id=conversation_id,
                message=initial_message if turn_number == 1 else "",
                review_resume_id=resume_id,
                model=args.model,
                api_url=args.api_url,
                timeout=args.timeout,
            )
            print(f"  reply: {text[:500]}")
            if review is None:
                if len(resolved_reviews) != len(expected_reviews):
                    raise RuntimeError(
                        "course flow finished before both structured reviews"
                    )
                final_question_events = question_events
                resume_id = None
                break

            if len(resolved_reviews) >= len(expected_reviews):
                raise RuntimeError(f"unexpected extra review gate: {review}")
            expected_kind, expected_gate = expected_reviews[len(resolved_reviews)]
            if (
                review.get("kind") != expected_kind
                or review.get("gate") != expected_gate
                or review.get("course_id") != course_id
            ):
                raise RuntimeError(
                    "unexpected review sequence: "
                    f"expected {expected_kind}/{expected_gate}, got "
                    f"{review.get('kind')}/{review.get('gate')}"
                )
            approved = await approve_review(
                api_url=args.api_url,
                conversation_id=conversation_id,
                review=review,
            )
            resolved_reviews.append((expected_kind, expected_gate))
            resume_id = str(approved["id"])
        else:
            raise RuntimeError("course flow did not finish after both review resumes")

        if resolved_reviews != expected_reviews:
            raise RuntimeError(f"structured review sequence incomplete: {resolved_reviews}")
        if final_question_events < 1:
            raise RuntimeError("G7 did not ask for final publish confirmation")
        print(
            "  structured reviews: "
            "knowledge-points/G2_IDENTITY_REVIEW -> "
            "knowledge-graph/G6_GRAPH_REVIEW"
        )
        print(f"  G7 publish questions: {final_question_events}")
        course_content = load_artifact(course_path, "1.0")
        index = load_artifact(index_path, "course-content-index/1.0")
        generation = load_artifact(
            generation_path,
            "course-content-generation/1.0",
        )
        animation_manifest = load_artifact(
            animation_manifest_path,
            "course-content-animations/1.0",
        )

        index_points = index.get("points") or []
        if len(index_points) != 10:
            raise RuntimeError("G1 did not generate exactly 10 index points")
        index_ids = [str(point.get("id") or "") for point in index_points]
        if not all(index_ids) or len(set(index_ids)) != 10:
            raise RuntimeError("G1 index point ids are missing or duplicated")
        if course_content.get("id") != course_id or index.get("courseId") != course_id:
            raise RuntimeError("course id is inconsistent across the v2 content package")
        subject = generation.get("subject") or {}
        if subject.get("id") != course_id:
            raise RuntimeError("generation manifest subject id mismatch")
        if (generation.get("generation") or {}).get("pointCount") != 10:
            raise RuntimeError("generation manifest pointCount is not 10")

        point_paths = sorted(points_root.glob("*.json"))
        request_paths = sorted(requests_root.glob("*.json"))
        if len(point_paths) != 10:
            raise RuntimeError(f"expected 10 point files, got {len(point_paths)}")
        if len(request_paths) != 10:
            raise RuntimeError(
                f"expected 10 animation request files, got {len(request_paths)}"
            )

        details = [json.loads(path.read_text(encoding="utf-8")) for path in point_paths]
        detail_by_id = {str(point.get("id") or ""): point for point in details}
        if set(detail_by_id) != set(index_ids) or len(detail_by_id) != 10:
            raise RuntimeError("point files do not match the frozen v2 index point set")
        if any(point.get("animationType") != "none" for point in details):
            raise RuntimeError(
                "the static-concept course unexpectedly produced an animation binding"
            )

        requests = [
            load_artifact(path, "animation-request/1.0") for path in request_paths
        ]
        request_ids = [str(request.get("pointId") or "") for request in requests]
        if set(request_ids) != set(index_ids) or len(set(request_ids)) != 10:
            raise RuntimeError("animation requests do not cover the 10-point set exactly")
        if any(request.get("needed") is not False for request in requests):
            raise RuntimeError(
                "a point was judged to need animation; the smoke expectation must not "
                "override that real assessment"
            )
        if animation_manifest.get("animations") != []:
            raise RuntimeError("expected an honestly empty animation manifest")
        print("  artifact: v2 course-content package ok (10 points, 10 requests)")

        graph = load_artifact(graph_path, "clustered-graph/2.0")
        graph_points = graph.get("points") or []
        graph_ids = [str(point.get("id") or "") for point in graph_points]
        if graph_ids != index_ids:
            raise RuntimeError("G6 graph did not preserve the frozen point order")
        for graph_point in graph_points:
            point_id = str(graph_point.get("id") or "")
            source_point = detail_by_id[point_id]
            for field, value in source_point.items():
                if field == "prerequisites":
                    continue
                if graph_point.get(field) != value:
                    raise RuntimeError(
                        f"G6 graph changed point content: {point_id}.{field}"
                    )
            if not graph_point.get("clusterIds"):
                raise RuntimeError(f"G6 graph omitted clusterIds for {point_id}")
            if graph_point.get("role") not in {"trunk", "branch", "leaf"}:
                raise RuntimeError(f"G6 graph has an invalid role for {point_id}")
            if not isinstance(graph_point.get("related"), list):
                raise RuntimeError(f"G6 graph omitted related for {point_id}")
            if not isinstance(graph_point.get("prerequisites"), list):
                raise RuntimeError(f"G6 graph omitted prerequisites for {point_id}")
        print("  artifact: clustered-graph.json v2 full-content pass-through ok")

    course_url = f"{args.api_url.rstrip('/')}/courses/{course_id}"
    async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
        response = await client.get(course_url)
        response.raise_for_status()
        published = True
        course = response.json()
        if course.get("id") != course_id:
            raise RuntimeError("published course id mismatch")
        print(f"  published: {course.get('title')} ({course_id})")
        if not args.keep:
            delete_response = await client.delete(course_url)
            delete_response.raise_for_status()
            published = False
            print("  cleanup: test course deleted")
            conversation_response = await client.delete(
                f"{args.api_url.rstrip('/')}/conversations/{conversation_id}"
            )
            conversation_response.raise_for_status()
            print("  cleanup: test conversation deleted")

    print("SMOKE TEST PASSED")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws-url", default="ws://127.0.0.1:8000/api/agent/ws")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000/api")
    parser.add_argument("--session-root", default=str(DEFAULT_SESSION_ROOT))
    parser.add_argument("--model")
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--keep", action="store_true")
    return parser.parse_args()


def main() -> int:
    try:
        return asyncio.run(main_async(parse_args()))
    except Exception as error:
        print(f"SMOKE TEST FAILED: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
