#!/usr/bin/env python3
"""Run the real WebSocket/OpenCode course-creation flow and clean up afterward."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
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
    message: str,
    model: str | None,
    api_url: str,
    timeout: float,
) -> tuple[str, int, list[dict]]:
    payload = {
        "conversation_id": conversation_id,
        "message": message,
        "images": [],
        "mode": "agent",
        "workflow": "course-create",
    }
    if model:
        payload["model"] = model
    await websocket.send(json.dumps({"type": "agent_request", "payload": payload}))

    chunks: list[str] = []
    question_events = 0
    review_events: list[dict] = []
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
            review = event_payload.get("review")
            if not isinstance(review, dict):
                review = event_payload
            review_id = str(review.get("id") or "")
            review_kind = str(review.get("kind") or "")
            if not review_id or review_kind not in {"knowledge-points", "prerequisites"}:
                raise RuntimeError(f"invalid agent_review_required payload: {event_payload!r}")
            review_events.append(review)
            print(f"  review required: {review_kind} ({review_id})")
        elif event_type == "agent_error":
            raise RuntimeError(str(event_payload.get("message") or "Agent error"))
        elif event_type == "agent_done":
            if int(event_payload.get("return_code") or 0) != 0:
                raise RuntimeError(f"Agent exited with {event_payload.get('return_code')}")
            return "".join(chunks).strip(), question_events, review_events


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


def hash_json(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def review_audit(graph: dict) -> list[dict[str, str]]:
    generation = graph.get("generation")
    audit = generation.get("refinedPrerequisiteEdges") if isinstance(generation, dict) else None
    if not isinstance(audit, list):
        raise RuntimeError("graph omitted generation.refinedPrerequisiteEdges")
    normalized: list[dict[str, str]] = []
    for entry in audit:
        if not isinstance(entry, dict):
            raise RuntimeError("graph prerequisite audit contains a non-object entry")
        normalized.append({
            "op": str(entry.get("op") or "").strip(),
            "from": str(entry.get("from") or "").strip(),
            "to": str(entry.get("to") or "").strip(),
            "reason": str(entry.get("reason") or "").strip(),
        })
    return normalized


def require_single_review(reviews: list[dict], expected_kind: str) -> dict:
    matching = [review for review in reviews if review.get("kind") == expected_kind]
    if len(reviews) != 1 or len(matching) != 1:
        raise RuntimeError(
            f"expected one {expected_kind} review event, got {reviews!r}"
        )
    return matching[0]


async def load_review(
    client: httpx.AsyncClient,
    *,
    api_url: str,
    pointer: dict,
    expected_kind: str,
    conversation_id: str,
) -> dict:
    review_id = str(pointer.get("id") or "")
    response = await client.get(
        f"{api_url.rstrip('/')}/agent/reviews/{review_id}"
    )
    response.raise_for_status()
    payload = response.json()
    review = payload.get("review") if isinstance(payload, dict) else None
    if not isinstance(review, dict):
        review = payload
    if (
        not isinstance(review, dict)
        or review.get("id") != review_id
        or review.get("kind") != expected_kind
        or review.get("status") != "pending"
        or review.get("conversation_id") != conversation_id
        or not isinstance(review.get("revision"), int)
        or not review.get("artifact_hash")
    ):
        raise RuntimeError(f"invalid {expected_kind} review resource: {review!r}")
    return review


async def approve_review(
    client: httpx.AsyncClient,
    *,
    api_url: str,
    review: dict,
    conversation_id: str,
) -> str:
    response = await client.post(
        f"{api_url.rstrip('/')}/agent/reviews/{review['id']}/submit",
        json={
            "conversation_id": conversation_id,
            "revision": review["revision"],
            "artifact_hash": review["artifact_hash"],
            "operations": [],
        },
    )
    response.raise_for_status()
    payload = response.json()
    resolved = payload.get("review") if isinstance(payload, dict) else None
    resume_message = payload.get("resume_message") if isinstance(payload, dict) else None
    if not isinstance(resolved, dict) or resolved.get("status") != "resolved":
        raise RuntimeError(f"review was not resolved: {payload!r}")
    if not isinstance(resume_message, str) or not resume_message.strip():
        raise RuntimeError("review response omitted resume_message")
    return resume_message.strip()


def assert_approval(
    path: Path,
    *,
    kind: str,
    identity: list[list[str]],
    edges: list[list[str]] | None = None,
    audit: list[dict[str, str]] | None = None,
) -> None:
    approval = load_artifact(path, "course-review-approval/1.0")
    expected_gate = (
        "G2_IDENTITY_REVIEW"
        if kind == "knowledge-points"
        else "G6_PREREQUISITE_REVIEW"
    )
    if (
        approval.get("kind") != kind
        or approval.get("gate") != expected_gate
        or not approval.get("review_id")
        or type(approval.get("operation_count")) is not int
        or approval["operation_count"] < 0
        or not isinstance(approval.get("submitted_operations"), list)
        or len(approval["submitted_operations"]) != approval["operation_count"]
        or not approval.get("approved_at")
    ):
        raise RuntimeError(f"approval metadata mismatch: {path}")
    if approval.get("identity_sha256") != hash_json(identity):
        raise RuntimeError(f"approval identity hash mismatch: {path}")
    if edges is not None and approval.get("prerequisites_sha256") != hash_json(edges):
        raise RuntimeError(f"approval prerequisite hash mismatch: {path}")
    if audit is not None and approval.get("review_audit_sha256") != hash_json(audit):
        raise RuntimeError(f"approval prerequisite audit hash mismatch: {path}")


async def assert_not_published(client: httpx.AsyncClient, course_url: str) -> None:
    response = await client.get(course_url)
    if response.status_code != 404:
        raise RuntimeError(
            f"course became visible before both review turns completed: {response.status_code}"
        )


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
    review_request_root = pipeline_root / "reviews"
    approval_root = session_root / ".course-review-approvals" / course_id
    course_url = f"{args.api_url.rstrip('/')}/courses/{course_id}"

    print(f"conversation_id={conversation_id}")
    print(f"course_id={course_id}")
    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
        async with websockets.connect(
            args.ws_url,
            max_size=16 * 1024 * 1024,
            proxy=None,
        ) as websocket:
            print("turn 1/3: generate G1 and stop for knowledge-point review")
            text, question_events, reviews = await run_turn(
                websocket,
                conversation_id=conversation_id,
                message=(
                    f"创建一门《软件工程文档元数据字段词典（v2 全流程测试）》课程，course-id 必须使用 {course_id}。"
                    "使用 full 和 model-only 模式，面向具备基础开发经验的软件工程初学者，深度为两小时入门。"
                    "课程只讲文档上静态记录的元数据字段，知识点必须恰好为：文档标题、文档唯一标识、文档版本号、"
                    "文档作者、文档所有者、文档适用范围、文档语言、文档密级、文档关键词、文档参考资料。"
                    "排除文档创建、修改、审批、发布、流转等过程，排除运行时交互、状态变化、算法执行、时间线演进、"
                    "工具操作和特定厂商格式。严格依次完成 G0_SCOPE 到 G7_RELEASE_READY，并把内容写入 v2 "
                    "course-content 包、把图写入其同级 clustered-graph.json。G1 index 校验通过后调用 "
                    "course_pipeline 的 review-knowledge-points 动作；返回 pending 时立即结束当前 turn，不调用 question，"
                    "不创建详情或动画请求。结构化审核恢复后才能进入 G3。动画请求仍须按真实动态机制逐点判断，"
                    "不得为测试预设 none 或绕过契约。G6 校验后同样运行 prerequisite 结构化审核并跨 turn 停止。"
                    "两份审批都有效且 G7 全部通过后，再使用 question 询问是否发布。"
                ),
                model=args.model,
                api_url=args.api_url,
                timeout=args.timeout,
            )
            print(f"  reply: {text[:500]}")
            if question_events != 0:
                raise RuntimeError(
                    f"G2 must use the review page, not generic questions ({question_events})"
                )
            knowledge_pointer = require_single_review(reviews, "knowledge-points")

            course_content = load_artifact(course_path, "1.0")
            index = load_artifact(index_path, "course-content-index/1.0")
            generation = load_artifact(
                generation_path,
                "course-content-generation/1.0",
            )
            index_points = index.get("points") or []
            if len(index_points) != 10:
                raise RuntimeError("G1 did not generate exactly 10 index points")
            index_ids = [str(point.get("id") or "") for point in index_points]
            if not all(index_ids) or len(set(index_ids)) != 10:
                raise RuntimeError("G1 index point ids are missing or duplicated")
            if course_content.get("id") != course_id or index.get("courseId") != course_id:
                raise RuntimeError("course id is inconsistent across the v2 content package")
            if (generation.get("subject") or {}).get("id") != course_id:
                raise RuntimeError("generation manifest subject id mismatch")
            if (generation.get("generation") or {}).get("pointCount") != 10:
                raise RuntimeError("generation manifest pointCount is not 10")
            if list(points_root.glob("*.json")) or list(requests_root.glob("*.json")):
                raise RuntimeError("G3 detail work started before knowledge-point approval")
            if animation_manifest_path.exists():
                raise RuntimeError("animation manifest was created before knowledge-point approval")
            if not (review_request_root / "knowledge-points.request.json").is_file():
                raise RuntimeError("knowledge-point request marker is missing")
            knowledge_approval_path = approval_root / "knowledge-points.json"
            if knowledge_approval_path.exists():
                raise RuntimeError("a model-written request was incorrectly treated as approval")
            await assert_not_published(client, course_url)

            knowledge_review = await load_review(
                client,
                api_url=args.api_url,
                pointer=knowledge_pointer,
                expected_kind="knowledge-points",
                conversation_id=conversation_id,
            )
            if len(knowledge_review.get("points") or []) != 10:
                raise RuntimeError("knowledge-point review does not contain the full point list")
            knowledge_resume = await approve_review(
                client,
                api_url=args.api_url,
                review=knowledge_review,
                conversation_id=conversation_id,
            )
            identity = [
                [str(point["id"]), str(point["title"]).strip()]
                for point in index_points
            ]
            assert_approval(
                knowledge_approval_path,
                kind="knowledge-points",
                identity=identity,
            )
            print("  boundary: G2 approved; no detail files existed before approval")

            print("turn 2/3: resume G3-G6 and stop for prerequisite review")
            text, question_events, reviews = await run_turn(
                websocket,
                conversation_id=conversation_id,
                message=knowledge_resume,
                model=args.model,
                api_url=args.api_url,
                timeout=args.timeout,
            )
            print(f"  reply: {text[:500]}")
            if question_events != 0:
                raise RuntimeError(
                    f"G6 prerequisite review must not use generic questions ({question_events})"
                )
            prerequisite_pointer = require_single_review(reviews, "prerequisites")

            animation_manifest = load_artifact(
                animation_manifest_path,
                "course-content-animations/1.0",
            )
            point_paths = sorted(points_root.glob("*.json"))
            request_paths = sorted(requests_root.glob("*.json"))
            if len(point_paths) != 10 or len(request_paths) != 10:
                raise RuntimeError(
                    f"expected 10 detail/request files, got {len(point_paths)}/{len(request_paths)}"
                )
            details = [json.loads(path.read_text(encoding="utf-8")) for path in point_paths]
            detail_by_id = {str(point.get("id") or ""): point for point in details}
            if set(detail_by_id) != set(index_ids) or len(detail_by_id) != 10:
                raise RuntimeError("point files do not match the frozen v2 index point set")
            if any(point.get("animationType") != "none" for point in details):
                raise RuntimeError("the static-concept course unexpectedly produced an animation binding")
            requests = [
                load_artifact(path, "animation-request/1.0") for path in request_paths
            ]
            request_ids = [str(request.get("pointId") or "") for request in requests]
            if set(request_ids) != set(index_ids) or len(set(request_ids)) != 10:
                raise RuntimeError("animation requests do not cover the 10-point set exactly")
            if any(request.get("needed") is not False for request in requests):
                raise RuntimeError(
                    "a point was judged to need animation; the smoke expectation must not override that assessment"
                )
            if animation_manifest.get("animations") != []:
                raise RuntimeError("expected an honestly empty animation manifest")

            graph = load_artifact(graph_path, "clustered-graph/2.0")
            graph_points = graph.get("points") or []
            graph_ids = [str(point.get("id") or "") for point in graph_points]
            if graph_ids != index_ids:
                raise RuntimeError("G6 graph did not preserve the frozen point order")
            for graph_point in graph_points:
                point_id = str(graph_point.get("id") or "")
                source_point = detail_by_id[point_id]
                for field, value in source_point.items():
                    if field != "prerequisites" and graph_point.get(field) != value:
                        raise RuntimeError(f"G6 graph changed point content: {point_id}.{field}")
                if not graph_point.get("clusterIds"):
                    raise RuntimeError(f"G6 graph omitted clusterIds for {point_id}")
                if graph_point.get("role") not in {"trunk", "branch", "leaf"}:
                    raise RuntimeError(f"G6 graph has an invalid role for {point_id}")
                if not isinstance(graph_point.get("related"), list):
                    raise RuntimeError(f"G6 graph omitted related for {point_id}")
                if not isinstance(graph_point.get("prerequisites"), list):
                    raise RuntimeError(f"G6 graph omitted prerequisites for {point_id}")
            prerequisite_approval_path = approval_root / "prerequisites.json"
            if not (review_request_root / "prerequisites.request.json").is_file():
                raise RuntimeError("prerequisite request marker is missing")
            if prerequisite_approval_path.exists():
                raise RuntimeError("prerequisite request was incorrectly treated as approval")
            await assert_not_published(client, course_url)

            prerequisite_review = await load_review(
                client,
                api_url=args.api_url,
                pointer=prerequisite_pointer,
                expected_kind="prerequisites",
                conversation_id=conversation_id,
            )
            prerequisite_resume = await approve_review(
                client,
                api_url=args.api_url,
                review=prerequisite_review,
                conversation_id=conversation_id,
            )
            approved_graph = load_artifact(graph_path, "clustered-graph/2.0")
            approved_graph_points = approved_graph.get("points") or []
            edges = sorted([
                [str(point["id"]), str(prerequisite)]
                for point in approved_graph_points
                for prerequisite in point.get("prerequisites") or []
            ])
            assert_approval(
                prerequisite_approval_path,
                kind="prerequisites",
                identity=identity,
                edges=edges,
                audit=review_audit(approved_graph),
            )
            print("  boundary: G6 prerequisite set approved; G7 had not published early")

            print("turn 3/3: resume G7, confirm publication and publish")
            text, question_events, reviews = await run_turn(
                websocket,
                conversation_id=conversation_id,
                message=prerequisite_resume,
                model=args.model,
                api_url=args.api_url,
                timeout=args.timeout,
            )
            print(f"  reply: {text[:500]}")
            if reviews:
                raise RuntimeError(f"unexpected repeated review after both approvals: {reviews!r}")
            if question_events < 1:
                raise RuntimeError("G7 did not ask for final publication confirmation")
            print(f"  publication questions: {question_events}")

        response = await client.get(course_url)
        response.raise_for_status()
        course = response.json()
        if course.get("id") != course_id:
            raise RuntimeError("published course id mismatch")
        print(f"  published: {course.get('title')} ({course_id})")
        if not args.keep:
            delete_response = await client.delete(course_url)
            delete_response.raise_for_status()
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
