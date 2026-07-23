import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let contracts;

before(async () => {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/features/reviews/types.ts";',
        'export * from "./src/features/reviews/resumeDelivery.ts";',
        'export * from "./src/utils/latestRequest.ts";',
      ].join("\n"),
      resolveDir: frontendRoot,
      sourcefile: "review-contract-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const output = result.outputFiles?.[0];
  assert.ok(output, "esbuild did not produce a test bundle");
  contracts = await import(`data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`);
});

function pointer(overrides = {}) {
  return {
    id: "review-1",
    kind: "knowledge-points",
    gate: "G2_IDENTITY_REVIEW",
    status: "resolved",
    revision: 1,
    artifact_hash: "a".repeat(64),
    conversation_id: "conversation-1",
    course_id: "course-1",
    course_title: "Course 1",
    summary: { total: 2 },
    resume_pending: true,
    resume_message: "continue pipeline",
    display_content: "已确认知识点",
    ...overrides,
  };
}

function resource(overrides = {}) {
  return {
    ...pointer(),
    points: [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ],
    review_queue: [],
    edges: [],
    related_pairs: [],
    broken_cycle_edges: [],
    ...overrides,
  };
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

test("pending aliases remain editable while terminal statuses are read-only", () => {
  for (const status of ["pending", "open", "unresolved", "awaiting_review", "draft"]) {
    assert.equal(contracts.isReviewReadOnly(status), false, status);
  }
  for (const status of ["resolved", "approved", "rejected", "expired"]) {
    assert.equal(contracts.isReviewReadOnly(status), true, status);
  }
});

test("durable resume pointers require the server pending flag", () => {
  const parsed = contracts.parseReviewPointer({ pending_review_resume: pointer() });
  assert.ok(parsed);
  assert.deepEqual(contracts.reviewResumeNavigation(parsed), {
    reviewId: "review-1",
    conversationId: "conversation-1",
    resumeMessage: "continue pipeline",
    displayContent: "已确认知识点",
  });

  const consumed = contracts.parseReviewPointer({
    pending_review_resume: pointer({ resume_pending: false }),
  });
  assert.ok(consumed);
  assert.equal(contracts.reviewResumeNavigation(consumed), null);
});

test("review queue arrays never turn numeric indexes into point ids", () => {
  const parsed = contracts.parseReviewResource(resource({
    review_queue: [
      { reason: "needs review" },
      { point_id: "a", reason: "ambiguous" },
      "b",
    ],
  }));
  assert.equal(parsed.review_queue[0].pointId, undefined);
  assert.equal(parsed.review_queue[1].pointId, "a");
  assert.equal(parsed.review_queue[2].pointId, "b");
});

test("dependency edges accept canonical and legacy field names", () => {
  const parsed = contracts.parseReviewResource(resource({
    kind: "prerequisites",
    gate: "G6_GRAPH",
    edges: [
      { dependent_id: "b", prerequisite_id: "a" },
      { from: "c", to: "b" },
    ],
  }));
  assert.deepEqual(parsed.edges, [
    { dependentId: "b", prerequisiteId: "a", reason: "" },
    { dependentId: "c", prerequisiteId: "b", reason: "" },
  ]);
});

test("related pairs are canonical, symmetric, and reject duplicate contracts", () => {
  const parsed = contracts.parseReviewResource(resource({
    kind: "prerequisites",
    gate: "G6_GRAPH",
    related_pairs: [
      { first_id: "c", second_id: "a" },
      { firstId: "b", secondId: "c" },
    ],
  }));
  assert.deepEqual(parsed.related_pairs, [
    { firstId: "a", secondId: "c" },
    { firstId: "b", secondId: "c" },
  ]);
  assert.equal(contracts.relatedPairKey("a", "c"), contracts.relatedPairKey("c", "a"));

  assert.throws(() => contracts.parseReviewResource(resource({
    related_pairs: [
      { first_id: "a", second_id: "c" },
      { first_id: "c", second_id: "a" },
    ],
  })), /重复知识点对/);
});

test("resume delivery releases only unconsumed failures", () => {
  const active = { reviewId: "review-1", conversationId: "conversation-1" };
  assert.equal(contracts.reviewResumeDeliveryOutcome(active, {
    type: "agent_review_resolved",
    payload: { conversation_id: "conversation-1", review: { id: "review-1" } },
  }), "consumed");
  assert.equal(contracts.reviewResumeDeliveryOutcome(active, {
    type: "agent_error",
    payload: { conversation_id: "conversation-1" },
  }), "failed");
  assert.equal(contracts.reviewResumeDeliveryOutcome(active, {
    type: "agent_done",
    payload: { conversation_id: "conversation-1", return_code: 1 },
  }), "failed");
  assert.equal(contracts.reviewResumeDeliveryOutcome(active, {
    type: "agent_done",
    payload: { conversation_id: "conversation-1", return_code: 0 },
  }), null);
  assert.equal(contracts.reviewResumeDeliveryOutcome(active, {
    type: "agent_error",
    payload: { conversation_id: "another-conversation" },
  }), null);
});

test("reconnect reconciliation trusts the durable conversation outbox", () => {
  const retry = contracts.reconcileReviewResume("review-1", {
    pending_review: null,
    pending_review_resume: pointer(),
  });
  assert.equal(retry.kind, "retry");
  assert.equal(retry.navigation.reviewId, "review-1");

  assert.deepEqual(contracts.reconcileReviewResume("review-1", {
    pending_review: null,
    pending_review_resume: null,
  }), { kind: "consumed" });
  assert.deepEqual(contracts.reconcileReviewResume("review-1", {
    pending_review: null,
    pending_review_resume: pointer({ id: "review-2" }),
  }), { kind: "consumed" });

  const nextReview = pointer({
    id: "review-2",
    status: "pending",
    resume_pending: false,
  });
  const pending = contracts.reconcileReviewResume("review-1", {
    pending_review: nextReview,
    pending_review_resume: null,
  });
  assert.equal(pending.kind, "pending-review");
  assert.equal(pending.review.id, "review-2");

  assert.throws(() => contracts.reconcileReviewResume("review-1", {
    pending_review: null,
    pending_review_resume: { id: "malformed" },
  }), /审核恢复任务格式无效/);
});

test("resume retries use a finite backoff budget", () => {
  assert.equal(contracts.reviewResumeRetryDelay(0), 350);
  assert.equal(contracts.reviewResumeRetryDelay(1), 350);
  assert.equal(contracts.reviewResumeRetryDelay(2), 1000);
  assert.equal(contracts.reviewResumeRetryDelay(5), 8000);
  assert.equal(contracts.reviewResumeRetryDelay(9), 45000);
  assert.equal(contracts.reviewResumeRetryDelay(10), null);
  assert.equal(contracts.reviewResumeRetryDelay(-1), null);
  assert.ok(contracts.reviewResumeRetryWindowMs() > 120_000);
  assert.ok(contracts.reviewResumeRetryWindowMs() < 180_000);
});

test("direct-linked G2 submission survives until AgentPanel mounts", () => {
  const storage = new MemoryStorage();
  const reviewRouteOutbox = new contracts.ReviewResumeOutbox(storage);
  const navigation = contracts.reviewResumeNavigation(pointer());
  assert.ok(navigation);

  // A direct review URL has no mounted AgentPanel to hear an immediate signal.
  contracts.queueReviewResume(navigation, reviewRouteOutbox, null);

  const mountedPanelOutbox = new contracts.ReviewResumeOutbox(storage);
  assert.deepEqual(mountedPanelOutbox.list(), [navigation]);
});

test("normal G6 navigation wakes a mounted consumer and clears only after acknowledgement", () => {
  const storage = new MemoryStorage();
  const outbox = new contracts.ReviewResumeOutbox(storage);
  const navigation = contracts.reviewResumeNavigation(pointer({
    id: "review-g6",
    kind: "prerequisites",
    gate: "G6_PREREQUISITE_REVIEW",
    resume_message: "continue graph pipeline",
    display_content: "已确认先修关系",
  }));
  assert.ok(navigation);
  const delivered = [];

  contracts.queueReviewResume(navigation, outbox, () => {
    delivered.push(...outbox.list());
  });

  assert.deepEqual(delivered, [navigation]);
  assert.deepEqual(outbox.list(), [navigation], "delivery must not acknowledge durable work");
  outbox.remove(navigation.reviewId);
  assert.deepEqual(outbox.list(), []);
  assert.equal(storage.getItem(contracts.REVIEW_RESUME_OUTBOX_KEY), null);
});

test("review resume outbox deduplicates updates and repairs malformed storage", () => {
  const storage = new MemoryStorage();
  storage.setItem(contracts.REVIEW_RESUME_OUTBOX_KEY, "not-json");
  const outbox = new contracts.ReviewResumeOutbox(storage);
  assert.deepEqual(outbox.list(), []);

  const first = {
    reviewId: "review-1",
    conversationId: "conversation-1",
    resumeMessage: "first message",
    displayContent: "first display",
  };
  const updated = {
    ...first,
    resumeMessage: "updated message",
    displayContent: "updated display",
  };
  outbox.enqueue(first);
  outbox.enqueue(updated);

  assert.deepEqual(new contracts.ReviewResumeOutbox(storage).list(), [updated]);
});

test("latest request guard aborts and invalidates stale conversation restores", () => {
  const guard = new contracts.LatestRequestGuard();
  const first = guard.start();
  assert.equal(guard.isCurrent(first), true);

  const second = guard.start();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.finish(first), false);
  assert.equal(guard.finish(second), true);

  const third = guard.start();
  guard.cancel();
  assert.equal(third.controller.signal.aborted, true);
  assert.equal(guard.isCurrent(third), false);
});
