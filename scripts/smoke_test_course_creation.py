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
    message: str,
    model: str | None,
    api_url: str,
    timeout: float,
) -> tuple[str, int]:
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
        elif event_type == "agent_error":
            raise RuntimeError(str(event_payload.get("message") or "Agent error"))
        elif event_type == "agent_done":
            if int(event_payload.get("return_code") or 0) != 0:
                raise RuntimeError(f"Agent exited with {event_payload.get('return_code')}")
            return "".join(chunks).strip(), question_events


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
            answers.append(["没有正则经验的开发初学者"])
        elif "深度" in prompt or "时长" in prompt:
            answers.append(["两小时入门"])
        elif "范围" in prompt:
            answers.append(["仅覆盖正则表达式基础使用与安全回溯"])
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
    candidate_path = session_root / "pipeline" / course_id / "candidate-points.json"
    graph_path = session_root / "pipeline" / course_id / "clustered-graph.json"
    published = False

    print(f"conversation_id={conversation_id}")
    print(f"course_id={course_id}")
    async with websockets.connect(
        args.ws_url,
        max_size=16 * 1024 * 1024,
        proxy=None,
    ) as websocket:
        print("turn 1/1: create, review, confirm and publish")
        text, question_events = await run_turn(
            websocket,
            conversation_id=conversation_id,
            message=(
                f"创建一门《正则表达式基础（结构化确认测试）》课程，course-id 必须使用 {course_id}。"
                "面向没有正则经验的开发初学者，深度为两小时入门；范围只包含字符、字符类、"
                "量词、分组、锚点、转义、匹配与替换、安全回溯和基础调试，排除特定语言 API、"
                "高级引擎实现和复杂形式语言理论。使用 model-only 模式，生成 10 个粒度清晰的"
                "候选知识点。完成 G1 后必须在 G2 使用 question 工具让我确认；确认通过后继续"
                "G3 和 G4，G4 校验通过后再次使用 question 工具询问是否发布。"
            ),
            model=args.model,
            api_url=args.api_url,
            timeout=args.timeout,
        )
        print(f"  reply: {text[:500]}")
        if question_events < 2:
            raise RuntimeError(f"expected at least 2 structured questions, got {question_events}")
        print(f"  structured questions: {question_events}")
        candidate = load_artifact(candidate_path, "candidate-points/1.0")
        if len(candidate.get("candidates") or []) != 10:
            raise RuntimeError("G1 did not generate exactly 10 candidates")
        print("  artifact: candidate-points.json ok (10 candidates)")
        graph = load_artifact(graph_path, "clustered-graph/1.0")
        if len(graph.get("points") or []) != 10:
            raise RuntimeError("G3 graph did not preserve the 10-point set")
        print("  artifact: clustered-graph.json ok (10 points)")

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
    parser.add_argument("--timeout", type=float, default=300.0)
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
