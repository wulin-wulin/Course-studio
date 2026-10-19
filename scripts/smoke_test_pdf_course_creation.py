#!/usr/bin/env python3
"""Exercise the real PDF/OpenCode pipeline against an independent textbook oracle.

Requires running backend/OpenCode services and an explicitly configured model.
Keeps the isolated test course, conversation, intermediate artifacts and evidence.
Use --manual-reviews to inspect each gate before creating <kind>.continue files.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import traceback
import uuid

import httpx
import websockets

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify_outline(outline: dict, oracle: dict, *, extensions: bool) -> list[dict]:
    chapters = outline["chapters"]
    assert len(chapters) == len(oracle["chapters"]), "chapter count drift"
    extra = []
    for chapter, expected in zip(chapters, oracle["chapters"], strict=True):
        for field in ("id", "number", "title", "page"):
            assert chapter.get(field) == expected[field], f"chapter drift: {expected['id']}.{field}"
        original = [p for p in chapter["points"] if p.get("origin") == "textbook"]
        assert len(original) == len(expected["points"]), f"textbook point loss: {chapter['id']}"
        for point, wanted in zip(original, expected["points"], strict=True):
            for field in ("id", "number", "title", "page", "origin"):
                assert point.get(field) == wanted[field], f"point drift: {wanted['id']}.{field}"
        extra_here = [p for p in chapter["points"] if p.get("origin") != "textbook"]
        assert extensions or not extra_here, "parser invented extension points"
        assert len(extra_here) <= oracle["extension_budget"]["max_per_chapter"], "extension budget exceeded"
        assert chapter["points"][:len(original)] == original, "extensions inserted among textbook points"
        for p in extra_here:
            assert p.get("origin") == "llm-extension", "invalid extension origin"
            assert p.get("anchor_point_id") in {o["id"] for o in original}, "cross-chapter extension anchor"
            assert str(p.get("extension_reason") or "").strip(), "extension reason missing"
        extra += extra_here
    return extra


def choose_answers(questions: list[dict]) -> list[list[str]]:
    results = []
    for q in questions:
        prompt = f"{q.get('header', '')} {q.get('question', '')}"
        labels = [str(o.get("label") or "").strip() for o in q.get("options", []) if isinstance(o, dict)]
        positive = next((label for label in labels if any(s in label for s in ("确认发布", "发布课程", "确认通过", "确认范围", "按教材", "入门", "推荐")) and not any(s in label for s in ("暂不", "不发布", "修改"))), None)
        if positive:
            results.append([positive])
        elif "受众" in prompt or "学习者" in prompt:
            results.append(["刚接触程序设计的初学者，无需特定编程语言基础"])
        elif "深度" in prompt or "时长" in prompt:
            results.append(["入门，60至90分钟，仅教材范围"])
        elif "发布" in prompt:
            results.append([next((s for s in labels if "发布" in s and "不" not in s), "确认发布独立测试课程")])
        else:
            results.append([positive or "按教材的两章十个原始知识点继续；保留教材结构，每章最多一个必要扩展点"])
    return results


async def run_turn(ws, client, args, state, message="", resume_id=None):
    payload = {"conversation_id":state["conversation_id"], "message":message, "images":[], "mode":"agent", "workflow":"course-create", "model":args.model, "textbook_document_id":state["document_id"]}
    if resume_id:
        payload["review_resume_id"] = resume_id
    await ws.send(json.dumps({"type":"agent_request", "payload":payload}, ensure_ascii=False))
    start = time.monotonic()
    review = None
    chunks = []
    question_count = 0
    last_status = None
    events_path = args.output / "events.jsonl"
    while True:
        if time.monotonic() - start > args.turn_timeout:
            raise TimeoutError("active model turn exceeded configured timeout")
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=30)
        except asyncio.TimeoutError:
            print(f"  waiting: {int(time.monotonic()-start)}s", flush=True)
            continue
        event = json.loads(raw)
        with events_path.open("a", encoding="utf-8") as log:
            log.write(json.dumps({"received_at":datetime.now(timezone.utc).isoformat(), **event}, ensure_ascii=False) + "\n")
        kind, data = event.get("type"), event.get("payload") or {}
        if kind == "agent_text_delta":
            chunks.append(str(data.get("text") or ""))
        elif kind == "agent_status":
            label = data.get("label")
            if label and label != last_status:
                print(f"  status: {label}", flush=True)
                last_status = label
        elif kind == "agent_question":
            answers = choose_answers(data.get("questions") or [])
            question_count += 1
            write_json(args.output / f"question-{int(time.time()*1000)}.json", {"question":data, "answers":answers})
            response = await client.post(f"/agent/questions/{data['request_id']}/reply", json={"conversation_id":state["conversation_id"],"answers":answers})
            response.raise_for_status()
            print(f"  answered: {answers}", flush=True)
        elif kind == "agent_review_required":
            assert review is None, "multiple gates in one turn"
            review = data
            print(f"  review: {data.get('kind')} {data.get('id')}", flush=True)
        elif kind == "agent_error":
            raise RuntimeError(str(data.get("message") or data))
        elif kind == "agent_done":
            reply = "".join(chunks)
            write_json(args.output / f"turn-{state['turn']}.json", {"elapsed_seconds":round(time.monotonic()-start,2),"question_count":question_count,"review":review,"reply":reply,"done":data})
            print(f"  reply: {reply[:450]}", flush=True)
            assert int(data.get("return_code") or 0) == 0, f"Agent failed: {data}"
            assert bool(data.get("awaiting_review")) == (review is not None), "review event/done mismatch"
            return review, question_count


async def main_async(args):
    args.output.mkdir(parents=True, exist_ok=True)
    oracle = read_json(args.oracle)
    pdf = args.pdf or (args.oracle.parent / oracle["pdf"])
    assert hashlib.sha256(pdf.read_bytes()).hexdigest() == oracle["sha256"], "fixture PDF changed"
    state = {"started_at":datetime.now(timezone.utc).isoformat(),"model":args.model,"conversation_id":"pdf-e2e-"+str(uuid.uuid4()),"turn":0,"status":"running"}
    write_json(args.output / "run.json", state)
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(base_url=args.api_url.rstrip('/'), timeout=200, trust_env=False) as client:
            for url in ("/health",):
                (await client.get(url)).raise_for_status()
            with pdf.open("rb") as stream:
                response = await client.post("/documents", files={"file":(pdf.name, stream, "application/pdf")})
            response.raise_for_status()
            metadata = response.json()
            state["document_id"] = metadata["id"]
            state["course_id"] = "textbook-"+metadata["id"][4:]
            state["session_root"] = str(PROJECT_ROOT / "packages/backend/generated/course_agent_sessions" / state["conversation_id"])
            write_json(args.output / "upload.json",metadata)
            with pdf.open("rb") as stream:
                response2 = await client.post("/documents", files={"file":(pdf.name, stream, "application/pdf")})
            response2.raise_for_status()
            assert response2.json()["id"] == state["document_id"], "duplicate upload was not idempotent"
            response = await client.post(f"/documents/{state['document_id']}/parse")
            response.raise_for_status()
            write_json(args.output / "parse.json",response.json())
            response = await client.get(f"/documents/{state['document_id']}/outline")
            response.raise_for_status()
            outline = response.json()
            write_json(args.output / "parsed-outline.json",outline)
            verify_outline(outline,oracle,extensions=False)
            print(f"PDF parse passed: {state['document_id']} / 2 chapters / 10 original points",flush=True)
            write_json(args.output / "run.json",state)
            initial = ("开始根据已绑定的 PDF 教材《数组与查找入门》创建课程，这是一次真实全链路验收。"
                "采用教材模式，严格遵守绑定的 course_id 和 textbook-outline-generator、knowledge-pipeline-orchestrator。"
                "受众是刚接触程序设计的初学者，深度为60至90分钟入门；范围为整数数组、顺序查找、闭区间二分查找及边界与复杂度。"
                "保留两章全部十个教材点及其编号、页码、身份、顺序和章节归属。"
                "每章最多补充一个确有必要的扩展知识点，必须附同章教材锚点和理由；没有必要时不扩展。"
                "扩展主题不得超出上述范围，不讲哈希表、树、递归或插值查找。"
                "G2前只生成索引和扩展规划，使用真实结构化审核并停止，审核恢复后再生成全部详情和动画请求。"
                "逐点如实判断动态机制，二分查找应有可观察区间收缩的教学动画，不能为简化测试把全部动画设为none。"
                "G6教材章节成为固定主簇，独立判断语义关系，不得把章节或目录顺序机械转为先修链。"
                "G6通过后进入最终全量校验，通过question询问测试课程发布确认，再通过工具正式发布。")
            ws_url=args.api_url.replace('http://','ws://').replace('https://','wss://').rstrip('/')+'/agent/ws'
            async with websockets.connect(ws_url,max_size=32*1024*1024,proxy=None,ping_interval=20) as ws:
                resume_id = None
                reviews = []
                for turn in range(1,7):
                    state["turn"] = turn
                    write_json(args.output / "run.json",state)
                    print(f"TURN {turn}: {'create' if not resume_id else 'resume '+resume_id}",flush=True)
                    review, questions = await run_turn(ws,client,args,state,initial if turn==1 else "",resume_id)
                    if review is None:
                        assert reviews == ["knowledge-points","knowledge-graph"], f"premature end: {reviews}"
                        assert questions > 0, "G7 did not request final publication confirmation"
                        break
                    expected = "knowledge-points" if not reviews else "knowledge-graph"
                    assert review["kind"] == expected and review["course_id"] == state["course_id"], "unexpected gate/course"
                    response = await client.get(f"/agent/reviews/{review['id']}")
                    response.raise_for_status()
                    detail = response.json()
                    write_json(args.output / f"review-{expected}.json",detail)
                    session=Path(state["session_root"])
                    pipeline=session/'pipeline'/state["course_id"]
                    current=read_json(pipeline/'textbook-outline.json')
                    extra=verify_outline(current,oracle,extensions=True)
                    write_json(args.output/f"outline-at-{expected}.json",current)
                    state["waiting_review"]=review
                    state["extension_count"]=len(extra)
                    write_json(args.output/'run.json',state)
                    if args.manual_reviews:
                        marker=args.output/f"{expected}.continue"
                        print(f"WAITING FOR INSPECTION: create {marker}",flush=True)
                        while not marker.exists():
                            await asyncio.sleep(2)
                    response=await client.post(f"/agent/reviews/{review['id']}/submit",json={"conversation_id":state["conversation_id"],"revision":detail["revision"],"artifact_hash":detail["artifact_hash"],"operations":[]})
                    response.raise_for_status()
                    submitted=response.json()
                    write_json(args.output/f"approved-{expected}.json",submitted)
                    assert submitted.get("ok") is True and submitted["review"]["status"] == "resolved", "review submit did not resolve"
                    reviews.append(expected)
                    resume_id=review["id"]
                    state.pop("waiting_review",None)
                else:
                    raise RuntimeError("too many turns")
            response=await client.get(f"/courses/{state['course_id']}")
            response.raise_for_status()
            write_json(args.output/'published-course.json',response.json())
            response=await client.get(f"/courses/{state['course_id']}/index")
            response.raise_for_status()
            write_json(args.output/'published-index.json',response.json())
            state.update(status="published",elapsed_seconds=round(time.monotonic()-started,2),review_approvals=len(reviews))
            print(f"PUBLISHED: {state['course_id']} ({state['elapsed_seconds']}s)",flush=True)
    except Exception as exc:
        state.update(status="failed",error=str(exc),elapsed_seconds=round(time.monotonic()-started,2))
        (args.output/'failure.txt').write_text(traceback.format_exc(),encoding='utf-8')
        raise
    finally:
        write_json(args.output/'run.json',state)


def parse_args():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--oracle',type=Path,required=True)
    parser.add_argument('--pdf',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--api-url',default='http://127.0.0.1:8000/api')
    parser.add_argument('--model',default='kimi-k2.6')
    parser.add_argument('--turn-timeout',type=float,default=3600)
    parser.add_argument('--manual-reviews',action='store_true')
    return parser.parse_args()


if __name__=='__main__':
    asyncio.run(main_async(parse_args()))
