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
        'export { isPersistableLiveGenerationConversationId, normalizePersistedRun, useCourseGenerationStore } from "./src/course/generation/generationStore.ts";',
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
  assert.ok(output);
  contracts = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  );
});

function pointer(overrides = {}) {
  return {
    id: "review-1",
    kind: "knowledge-points",
    gate: "G2",
    status: "pending",
    revision: 1,
    artifact_hash: "a".repeat(64),
    conversation_id: "conversation-1",
    course_id: "course-1",
    course_title: "Course 1",
    summary: { total: 2 },
    ...overrides,
  };
}

function graphResource(overrides = {}) {
  return {
    ...pointer({ kind: "knowledge-graph", gate: "G6" }),
    clusters: [
      { id: "core", title: "核心" },
      { id: "practice", title: "实践" },
    ],
    points: [
      {
        id: "a",
        title: "A",
        clusterIds: ["core"],
        prerequisites: [],
        related: ["c"],
      },
      {
        id: "b",
        title: "B",
        cluster_ids: ["core", "practice"],
        prerequisites: ["a"],
        related: [],
      },
      {
        id: "c",
        title: "C",
        clusterIds: ["practice"],
        prerequisites: ["b"],
        related: ["a"],
      },
    ],
    review_queue: [],
    ...overrides,
  };
}

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

test("only the two supported review kinds are exposed", () => {
  assert.equal(contracts.parseReviewPointer(pointer())?.kind, "knowledge-points");
  assert.equal(
    contracts.parseReviewPointer(pointer({ kind: "knowledge-graph" }))?.kind,
    "knowledge-graph",
  );
  assert.equal(
    contracts.parseReviewPointer(pointer({ kind: "prerequisites" }))?.kind,
    "knowledge-graph",
    "legacy payload remains readable but normalizes to the fixed kind",
  );
});

test("knowledge graph parser preserves multi-cluster, prerequisites, and related", () => {
  const review = contracts.parseReviewResource(graphResource());
  assert.deepEqual(review.points[1].clusterIds, ["core", "practice"]);
  assert.deepEqual(review.points[1].prerequisites, ["a"]);
  assert.deepEqual(review.points[0].related, ["c"]);
  assert.equal(review.clusters.length, 2);
});

test("knowledge graph rejects unknown clusters and invalid edges", () => {
  assert.throws(
    () =>
      contracts.parseReviewResource(
        graphResource({
          points: [
            {
              id: "a",
              title: "A",
              clusterIds: ["missing"],
              prerequisites: [],
              related: [],
            },
          ],
        }),
      ),
    /未知知识簇/,
  );
});

test("front-end cycle guard detects a newly introduced prerequisite loop", () => {
  assert.equal(
    contracts.findDependencyCycle(
      ["a", "b", "c"],
      [
        { pointId: "b", prerequisiteId: "a" },
        { pointId: "c", prerequisiteId: "b" },
      ],
    ),
    null,
  );
  assert.deepEqual(
    contracts.findDependencyCycle(
      ["a", "b", "c"],
      [
        { pointId: "b", prerequisiteId: "a" },
        { pointId: "c", prerequisiteId: "b" },
        { pointId: "a", prerequisiteId: "c" },
      ],
    ),
    ["a", "c", "b", "a"],
  );
});

test("zero-operation resolved review produces a durable resume navigation", () => {
  const review = contracts.parseReviewPointer({
    pending_review_resume: pointer({
      status: "resolved",
      resume_pending: true,
      resume_message: "continue pipeline",
      display_content: "已确认且无修改",
    }),
  });
  assert.ok(review);
  assert.deepEqual(contracts.reviewResumeNavigation(review), {
    reviewId: "review-1",
    conversationId: "conversation-1",
    resumeMessage: "continue pipeline",
    displayContent: "已确认且无修改",
  });
});

test("resume outbox survives remount and removes only acknowledged work", () => {
  const storage = new MemoryStorage();
  const outbox = new contracts.ReviewResumeOutbox(storage);
  const item = {
    reviewId: "review-1",
    conversationId: "conversation-1",
    resumeMessage: "continue",
    displayContent: "已确认",
  };
  outbox.enqueue(item);
  assert.deepEqual(new contracts.ReviewResumeOutbox(storage).list(), [item]);
  assert.equal(
    contracts.reviewResumeDeliveryOutcome(item, {
      type: "agent_done",
      payload: { conversation_id: "conversation-1", return_code: 0 },
    }),
    null,
  );
  assert.equal(
    contracts.reviewResumeDeliveryOutcome(item, {
      type: "agent_review_resolved",
      payload: {
        conversation_id: "conversation-1",
        review_id: "review-1",
      },
    }),
    "consumed",
  );
  outbox.remove("review-1");
  assert.deepEqual(outbox.list(), []);
});

test("conversation cleanup removes every queued review resume for that flow", () => {
  const outbox = new contracts.ReviewResumeOutbox(new MemoryStorage());
  outbox.enqueue({
    reviewId: "review-a",
    conversationId: "conversation-a",
    resumeMessage: "continue a",
    displayContent: "已确认 A",
  });
  outbox.enqueue({
    reviewId: "review-b",
    conversationId: "conversation-b",
    resumeMessage: "continue b",
    displayContent: "已确认 B",
  });

  outbox.removeConversation("conversation-a");

  assert.deepEqual(outbox.list().map((item) => item.reviewId), ["review-b"]);
});

test("stale conversation reconciliation prefers the next pending review", () => {
  const decision = contracts.reconcileReviewResume("review-1", {
    pending_review: pointer({
      id: "review-2",
      kind: "knowledge-graph",
      gate: "G6",
    }),
    pending_review_resume: null,
  });
  assert.equal(decision.kind, "pending-review");
  assert.equal(decision.review.id, "review-2");
});

test("synthetic course-creation smoke runs are excluded from persistence", () => {
  assert.equal(
    contracts.isPersistableLiveGenerationConversationId(
      "course-creation-smoke-16b25c89-5cb7-4300-a3b2-6b5f49d02a1c",
    ),
    false,
  );
  assert.equal(
    contracts.isPersistableLiveGenerationConversationId("  course-creation-smoke-test-run  "),
    false,
  );
  assert.equal(
    contracts.isPersistableLiveGenerationConversationId("real-course-conversation"),
    true,
  );
});

test("synthetic course-creation smoke events never enter the live generation store", () => {
  const conversationId = "course-creation-smoke-store-ingress";
  const store = contracts.useCourseGenerationStore;

  store.getState().startLive(conversationId);
  store.getState().applySnapshot({
    conversation_id: conversationId,
    gate: "G0_SCOPE",
    course: null,
    points: [],
    clusters: [],
  });
  store.getState().markLiveError(conversationId, "synthetic failure");

  assert.equal(store.getState().liveRuns[conversationId], undefined);
  assert.notEqual(store.getState().conversationId, conversationId);
});

test("a live generation left running across reload is restored as resumable", () => {
  const run = contracts.normalizePersistedRun({
    conversationId: "interrupted-course-conversation",
    status: "running",
    course: null,
    gate: "G0_SCOPE",
    phaseLabel: "等待课程范围",
    phaseDetail: "等待用户输入",
    totalPoints: 0,
    points: [],
    clusters: [],
    published: false,
    publishedCourseId: null,
    error: null,
    updatedAt: 123,
    snapshotKey: "",
  });

  assert.equal(run.status, "paused");
  assert.match(run.error, /可以从当前进度继续/);
});

test("stale live generations pause and can explicitly resume", () => {
  const conversationId = "real-stale-course-conversation";
  const store = contracts.useCourseGenerationStore;
  store.getState().startLive(conversationId);
  const startedAt = store.getState().liveRuns[conversationId].updatedAt;

  store.getState().pauseStaleLiveRuns(startedAt + 120_001);
  assert.equal(store.getState().liveRuns[conversationId].status, "paused");

  store.getState().resumeLive(conversationId);
  assert.equal(store.getState().liveRuns[conversationId].status, "running");
  assert.equal(store.getState().liveRuns[conversationId].error, null);

  store.getState().pauseLive(conversationId, "connection interrupted");
  assert.equal(store.getState().liveRuns[conversationId].status, "paused");
  assert.equal(
    store.getState().liveRuns[conversationId].error,
    "connection interrupted",
  );

  store.getState().touchLive(conversationId, Date.now() + 1);
  assert.equal(store.getState().liveRuns[conversationId].status, "running");
  assert.equal(store.getState().liveRuns[conversationId].error, null);
  store.getState().removeLive(conversationId);
});
