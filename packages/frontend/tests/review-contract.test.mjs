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
        'export * from "./src/features/courseCreation/setup.ts";',
        'export { buildCourseDirectory, buildCourseReadingOrder, buildSceneInputs, normalizeForestIndex } from "./src/course/forest/forestAdapter.ts";',
        'export * from "./src/utils/latestRequest.ts";',
        'export { isPersistableLiveGenerationConversationId, normalizePersistedRun, shouldCompleteCourseCreationAfterAgentDone, shouldPauseGenerationAfterAgentDone, shouldRestoreCourseCreationWorkflow, useCourseGenerationStore } from "./src/course/generation/generationStore.ts";',
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

test("course index parser preserves canonical cluster and point sequence edges", () => {
  const index = contracts.normalizeForestIndex({
    clusters: [
      { id: "cluster-a", title: "A" },
      { id: "cluster-b", title: "B" },
    ],
    points: [
      { id: "point-a", title: "A1", clusterId: "cluster-a" },
      { id: "point-b", title: "B1", clusterId: "cluster-b" },
    ],
    sequences: {
      cluster: [{ fromId: "cluster-a", toId: "cluster-b" }],
      point: [{ fromId: "point-a", toId: "point-b" }],
    },
  });

  assert.deepEqual(index.sequences, {
    cluster: [{ fromId: "cluster-a", toId: "cluster-b" }],
    point: [{ fromId: "point-a", toId: "point-b" }],
  });
});

test("course reader follows explicit chapter and point order across chapter boundaries", () => {
  const index = {
    clusters: [
      { id: "chapter-b", title: "第二章" },
      { id: "chapter-a", title: "第一章" },
    ],
    points: [
      { id: "b-2", title: "B2", clusterId: "chapter-b" },
      { id: "a-2", title: "A2", clusterId: "chapter-a" },
      { id: "b-1", title: "B1", clusterId: "chapter-b" },
      { id: "a-1", title: "A1", clusterId: "chapter-a" },
    ],
    sequences: {
      cluster: [{ fromId: "chapter-a", toId: "chapter-b" }],
      point: [
        { fromId: "a-1", toId: "a-2" },
        { fromId: "b-1", toId: "b-2" },
      ],
    },
  };

  assert.deepEqual(
    contracts.buildCourseReadingOrder(index).map((point) => point.id),
    ["a-1", "a-2", "b-1", "b-2"],
  );
  assert.deepEqual(
    contracts.buildCourseDirectory(index).map((group) => ({
      cluster: group.cluster.id,
      points: group.points.map((point) => point.id),
    })),
    [
      { cluster: "chapter-a", points: ["a-1", "a-2"] },
      { cluster: "chapter-b", points: ["b-1", "b-2"] },
    ],
  );
});

test("course reader keeps legacy source order and does not drop cyclic sequence items", () => {
  const legacy = {
    clusters: [{ id: "chapter", title: "章节" }],
    points: [
      { id: "one", title: "一", clusterId: "chapter" },
      { id: "two", title: "二", clusterId: "chapter" },
    ],
  };
  assert.deepEqual(
    contracts.buildCourseReadingOrder(legacy).map((point) => point.id),
    ["one", "two"],
  );

  const cyclic = {
    ...legacy,
    sequences: {
      cluster: [],
      point: [
        { fromId: "one", toId: "two" },
        { fromId: "two", toId: "one" },
      ],
    },
  };
  assert.deepEqual(
    contracts.buildCourseReadingOrder(cyclic).map((point) => point.id),
    ["one", "two"],
  );
});

test("forest scene adapter preserves textbook point origins and legacy absence", () => {
  const scene = contracts.buildSceneInputs({
    clusters: [{ id: "cluster-a", title: "A", accent: "#2f7567" }],
    points: [
      {
        id: "textbook-point",
        title: "教材点",
        clusterId: "cluster-a",
        origin: "textbook",
        pos: [100, 100],
      },
      {
        id: "extension-point",
        title: "扩展点",
        clusterId: "cluster-a",
        origin: "llm-extension",
        pos: [200, 100],
      },
      {
        id: "legacy-point",
        title: "旧课程点",
        clusterId: "cluster-a",
        pos: [300, 100],
      },
    ],
  });

  assert.equal(scene.data.kpById["textbook-point"].origin, "textbook");
  assert.equal(scene.data.kpById["extension-point"].origin, "llm-extension");
  assert.equal(scene.data.kpById["legacy-point"].origin, undefined);
});

test("course index parser keeps old courses readable and filters malformed sequence edges", () => {
  const legacy = contracts.normalizeForestIndex({
    clusters: [{ id: "cluster-a", title: "A" }],
    points: [{ id: "point-a", title: "A1", clusterId: "cluster-a" }],
  });
  assert.equal(legacy.sequences, undefined);

  const compatible = contracts.normalizeForestIndex({
    clusters: [
      { id: "cluster-a", title: "A" },
      { id: "cluster-b", title: "B" },
    ],
    points: [
      { id: "point-a", title: "A1", clusterId: "cluster-a" },
      { id: "point-b", title: "B1", clusterId: "cluster-b" },
    ],
    sequence: {
      cluster_ids: ["cluster-a", "cluster-b"],
      point_edges: [
        { from_id: "point-a", to_id: "point-b" },
        { from_id: "point-a", to_id: "missing" },
        { from_id: "point-a", to_id: "point-a" },
      ],
    },
  });
  assert.deepEqual(compatible.sequences, {
    cluster: [{ fromId: "cluster-a", toId: "cluster-b" }],
    point: [{ fromId: "point-a", toId: "point-b" }],
  });
});

test("knowledge point parser preserves a textbook chapter tree and structure hash", () => {
  const review = contracts.parseReviewResource({
    ...pointer(),
    textbook_structure_sha256: "b".repeat(64),
    textbook_outline: {
      schema_version: "textbook-outline/1.0",
      document_id: "doc-123",
      title: "教材课程",
      chapters: [
        {
          id: "chapter-one",
          title: "第一章",
          order: 0,
          points: [
            { id: "point-one", title: "第一个知识点", origin: "textbook", order: 0 },
            { id: "point-two", title: "扩展点", origin: "llm-extension", order: 1 },
          ],
        },
      ],
    },
    points: [
      {
        id: "point-one",
        title: "第一个知识点",
        key_terms: [],
        issues: [],
        cluster_ids: [],
        prerequisites: [],
        related: [],
      },
      {
        id: "point-two",
        title: "扩展点",
        key_terms: [],
        issues: [],
        cluster_ids: [],
        prerequisites: [],
        related: [],
      },
    ],
    review_queue: [],
  });
  assert.equal(review.textbookOutline?.chapters[0].title, "第一章");
  assert.equal(review.textbookOutline?.chapters[0].points[1].origin, "llm-extension");
  assert.equal(review.textbookStructureSha256, "b".repeat(64));
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
      type: "agent_question",
      payload: {
        conversation_id: "conversation-1",
        request_id: "question-g7",
      },
    }),
    "consumed",
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

test("resume delivery stays locked while retry reconciliation is pending", () => {
  const ready = {
    inFlight: false,
    retryScheduled: false,
    reconcileInProgress: false,
    socketOpen: true,
  };
  assert.equal(contracts.shouldDeliverReviewResume(ready), true);
  assert.equal(
    contracts.shouldDeliverReviewResume({ ...ready, inFlight: true }),
    false,
  );
  assert.equal(
    contracts.shouldDeliverReviewResume({ ...ready, retryScheduled: true }),
    false,
  );
  assert.equal(
    contracts.shouldDeliverReviewResume({ ...ready, reconcileInProgress: true }),
    false,
  );
  assert.equal(
    contracts.shouldDeliverReviewResume({ ...ready, socketOpen: false }),
    false,
  );
});

test("deleted conversations terminate review resume delivery", () => {
  assert.equal(contracts.isReviewResumeConversationGoneStatus(404), true);
  assert.equal(contracts.isReviewResumeConversationGoneStatus(410), true);
  assert.equal(contracts.isReviewResumeConversationGoneStatus(409), false);
  assert.equal(contracts.isReviewResumeConversationGoneStatus(500), false);
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

test("a canonical resume replaces a stale resume from the same conversation", () => {
  const outbox = new contracts.ReviewResumeOutbox(new MemoryStorage());
  outbox.enqueue({
    reviewId: "stale-review",
    conversationId: "conversation-a",
    resumeMessage: "continue stale",
    displayContent: "已确认旧审核",
  });
  outbox.enqueue({
    reviewId: "other-review",
    conversationId: "conversation-b",
    resumeMessage: "continue other",
    displayContent: "已确认其他审核",
  });
  const canonical = {
    reviewId: "canonical-review",
    conversationId: "conversation-a",
    resumeMessage: "continue canonical",
    displayContent: "已确认最新审核",
  };

  outbox.enqueue(canonical);

  assert.deepEqual(outbox.list(), [
    {
      reviewId: "other-review",
      conversationId: "conversation-b",
      resumeMessage: "continue other",
      displayContent: "已确认其他审核",
    },
    canonical,
  ]);
});

test("course creation setup normalizes the locally collected topic", () => {
  assert.equal(
    contracts.normalizeCourseCreationTopic([["  编译原理  "], ["  "]]),
    "编译原理",
  );
  assert.equal(contracts.normalizeCourseCreationTopic([[]]), "");
});

test("course creation starts with the confirmed topic in the first message", () => {
  assert.equal(contracts.prepareCourseCreationRequest([[]]), null);
  const request = contracts.prepareCourseCreationRequest([["软件工程"]]);
  assert.equal(request.topic, "软件工程");
  assert.match(request.message, /课程或领域名称：软件工程/);
  assert.doesNotMatch(request.message, /如果我还没有提供/);
  assert.equal(request.displayContent, "创建课程：软件工程");
});

test("textbook course creation preserves identity and requires grounded content", () => {
  assert.equal(
    contracts.preparePdfCourseCreationRequest({ id: "", filename: "教材.pdf" }),
    null,
  );
  const request = contracts.preparePdfCourseCreationRequest({
    id: "document-1",
    filename: "数据结构教材.pdf",
  });
  assert.equal(request.documentId, "document-1");
  assert.equal(request.filename, "数据结构教材.pdf");
  assert.equal(request.displayContent, "根据教材创建课程：数据结构教材.pdf");
  assert.match(request.message, /章节 → 知识点/);
  assert.match(request.message, /material\.json/);
  assert.match(request.message, /full\.md/);
  assert.match(request.message, /不得只根据标题编写内容/);
  assert.match(request.message, /textbook-content\/2\.0/);
  assert.match(request.message, /教材块记录 sourceSpans/);
  assert.match(request.message, /模型补充块通过 basedOnBlockIds/);
  assert.match(request.message, /顶层 sourceSpans\/modelEnriched 只在发布时由 blocks 派生/);
  assert.match(request.message, /平衡重编/);
  assert.match(request.message, /教材约束事实、定义、公式、适用条件和知识覆盖/);
  assert.match(request.message, /重新安排讲解顺序/);
  assert.match(request.message, /adaptationLevel 默认使用 balanced/);
  assert.match(request.message, /learningDesign\.editorialPolicy 用于记录本知识点的教学重编原则/);
  assert.match(request.message, /通常为 4 至 7 个/);
  assert.match(request.message, /不要在正文重复顶部已经展示的完整学习目标列表/);
  assert.match(request.message, /estimatedMinutes 需要计入正文、公式表格、互动和练习的总学习时间/);
  assert.doesNotMatch(request.message, /不要求逐段还原教材正文/);
  assert.match(request.message, /不得重新聚类或改变已确认的章节归属/);
});

test("textbook upload accepts compatible PDF and Markdown file descriptors", () => {
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.PDF", type: "application/pdf" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.pdf", type: "" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.pdf", type: "application/x-pdf" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.MD", type: "text/plain" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.markdown", type: "text/markdown" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.md", type: "binary/octet-stream" }),
    true,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.md", type: "application/pdf" }),
    false,
  );
  assert.equal(
    contracts.isSupportedTextbookFile({ name: "教材.txt", type: "text/plain" }),
    false,
  );
  assert.match(contracts.TEXTBOOK_FILE_ACCEPT, /application\/pdf/);
  assert.match(contracts.TEXTBOOK_FILE_ACCEPT, /text\/markdown/);
  assert.match(contracts.TEXTBOOK_FILE_ACCEPT, /\.md/);
});

test("dedicated Markdown import rejects PDFs and accepts MinerU full.md", () => {
  assert.equal(
    contracts.isSupportedMarkdownTextbookFile({
      name: "full.md",
      type: "text/markdown; charset=utf-8",
    }),
    true,
  );
  assert.equal(
    contracts.isSupportedMarkdownTextbookFile({
      name: "教材.markdown",
      type: "application/octet-stream",
    }),
    true,
  );
  assert.equal(
    contracts.isSupportedMarkdownTextbookFile({
      name: "教材.pdf",
      type: "application/pdf",
    }),
    false,
  );
  assert.match(contracts.MARKDOWN_TEXTBOOK_FILE_ACCEPT, /text\/markdown/);
  assert.match(contracts.MARKDOWN_TEXTBOOK_FILE_ACCEPT, /\.markdown/);
});

test("dedicated PDF creation rejects Markdown files", () => {
  assert.equal(
    contracts.isSupportedPdfTextbookFile({
      name: "教材.pdf",
      type: "application/pdf",
    }),
    true,
  );
  assert.equal(
    contracts.isSupportedPdfTextbookFile({
      name: "教材.pdf",
      type: "",
    }),
    true,
  );
  assert.equal(
    contracts.isSupportedPdfTextbookFile({
      name: "full.md",
      type: "text/markdown",
    }),
    false,
  );
  assert.match(contracts.PDF_TEXTBOOK_FILE_ACCEPT, /application\/pdf/);
  assert.match(contracts.PDF_TEXTBOOK_FILE_ACCEPT, /\.pdf/);
});

test("dedicated Markdown creation describes the graph generation action", () => {
  const request = contracts.prepareMarkdownCourseCreationRequest({
    id: "document-markdown-1",
    filename: "full.md",
  });
  assert.equal(request.documentId, "document-markdown-1");
  assert.equal(request.displayContent, "根据 Markdown 生成知识图谱：full.md");
  assert.match(request.message, /material\.json/);
  assert.match(request.message, /full\.md/);
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

test("a downstream native question consumes the stale review resume", () => {
  const decision = contracts.reconcileReviewResume("review-1", {
    pending_question: {
      request_id: "question-g7",
      conversation_id: "conversation-1",
      questions: [
        {
          header: "G7_RELEASE_READY",
          question: "确认发布？",
          options: [{ label: "确认发布", description: "生成正式课程" }],
        },
      ],
    },
    pending_review: null,
    pending_review_resume: pointer({
      status: "resolved",
      resume_pending: true,
      resume_message: "continue pipeline",
      display_content: "已确认知识图谱",
    }),
  });

  assert.deepEqual(decision, { kind: "consumed" });
});

test("a restored G7 question clears a failed generation and waits for input", () => {
  const conversationId = "generation-waiting-for-g7";
  const store = contracts.useCourseGenerationStore;

  store.getState().startLive(conversationId);
  store.getState().markLiveError(conversationId, "stale duplicate resume error");
  store.getState().markAwaitingInput(conversationId, {
    gate: "G7_RELEASE_READY",
    label: "等待发布确认",
    detail: "请在右侧选择是否发布。",
  });

  const run = store.getState().liveRuns[conversationId];
  assert.equal(run.status, "awaiting-input");
  assert.equal(run.error, null);
  assert.equal(run.gate, "G7_RELEASE_READY");
  assert.equal(run.phaseLabel, "等待发布确认");
  assert.equal(
    contracts.normalizePersistedRun(run).status,
    "awaiting-input",
  );

  store.getState().removeLive(conversationId);
});

test("stale resume reconciliation adopts the server canonical review", () => {
  const decision = contracts.reconcileReviewResume("stale-review", {
    pending_review: null,
    pending_review_resume: pointer({
      id: "canonical-review",
      status: "resolved",
      resume_pending: true,
      resume_message: "continue canonical",
      display_content: "已确认最新审核",
    }),
  });

  assert.deepEqual(decision, {
    kind: "retry",
    navigation: {
      reviewId: "canonical-review",
      conversationId: "conversation-1",
      resumeMessage: "continue canonical",
      displayContent: "已确认最新审核",
    },
  });
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

test("agent done preserves a live generation that is waiting for review", () => {
  const activeRun = { published: false };
  assert.equal(
    contracts.shouldPauseGenerationAfterAgentDone({}, activeRun),
    true,
  );
  assert.equal(
    contracts.shouldPauseGenerationAfterAgentDone(
      { awaiting_review: true },
      activeRun,
    ),
    false,
  );
  assert.equal(
    contracts.shouldPauseGenerationAfterAgentDone(
      { awaitingReview: true },
      activeRun,
    ),
    false,
  );
  assert.equal(
    contracts.shouldPauseGenerationAfterAgentDone({}, { published: true }),
    false,
  );
  assert.equal(
    contracts.shouldPauseGenerationAfterAgentDone({}, undefined),
    false,
  );
});

test("course creation unlocks only after a successful published agent turn", () => {
  assert.equal(
    contracts.shouldCompleteCourseCreationAfterAgentDone(
      { return_code: 0 },
      { published: true, status: "completed" },
    ),
    true,
  );
  assert.equal(
    contracts.shouldCompleteCourseCreationAfterAgentDone(
      { return_code: 0, awaiting_review: true },
      { published: false, status: "awaiting-input" },
    ),
    false,
  );
  assert.equal(
    contracts.shouldCompleteCourseCreationAfterAgentDone(
      { return_code: 1 },
      { published: true, status: "completed" },
    ),
    false,
  );
  assert.equal(
    contracts.shouldCompleteCourseCreationAfterAgentDone(
      { return_code: 0 },
      undefined,
    ),
    false,
  );
});

test("reopening history keeps only unfinished course creation workflows locked", () => {
  assert.equal(
    contracts.shouldRestoreCourseCreationWorkflow(
      "course-create",
      { published: true, status: "completed" },
    ),
    false,
  );
  assert.equal(
    contracts.shouldRestoreCourseCreationWorkflow(
      "course-create",
      { published: false, status: "completed" },
    ),
    false,
  );
  assert.equal(
    contracts.shouldRestoreCourseCreationWorkflow(
      "course-create",
      { published: false, status: "awaiting-input" },
    ),
    true,
  );
  assert.equal(
    contracts.shouldRestoreCourseCreationWorkflow(
      "course-create",
      { published: true, status: "completed" },
      true,
    ),
    true,
    "a pending review or native question takes precedence over persisted completion",
  );
  assert.equal(
    contracts.shouldRestoreCourseCreationWorkflow(
      "default",
      { published: false, status: "running" },
    ),
    false,
  );
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
