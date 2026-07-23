export type ReviewKind = "knowledge-points" | "prerequisites";

export type ReviewSummary = Record<string, number>;

export type ReviewPointer = {
  id: string;
  kind: ReviewKind;
  gate: string;
  status: string;
  revision: number;
  artifact_hash: string;
  conversation_id: string;
  course_id: string;
  course_title: string;
  summary: ReviewSummary;
  review_url?: string;
  resume_pending?: boolean;
  resume_message?: string;
  display_content?: string;
};

export type ReviewPoint = {
  id: string;
  title: string;
  shortSummary?: string;
  difficulty?: string;
  importance?: number;
  keyTerms: string[];
  kind?: string;
  confidence?: number;
  scopeStatus?: string;
  issues: ReviewIssue[];
  clusterIds: string[];
  role?: string;
};

export type ReviewIssue = {
  pointId?: string;
  term?: string;
  issue?: string;
  reason?: string;
  suggestedAction?: string;
};

export type ReviewQueueItem = ReviewIssue;

export type ReviewEdge = {
  dependentId: string;
  prerequisiteId: string;
  reason: string;
};

export type ReviewRelatedPair = {
  firstId: string;
  secondId: string;
};

export type BrokenCycleEdge = ReviewEdge & {
  cycleId?: string;
};

export type ReviewResource = ReviewPointer & {
  points: ReviewPoint[];
  review_queue: ReviewQueueItem[];
  edges: ReviewEdge[];
  related_pairs: ReviewRelatedPair[];
  broken_cycle_edges: BrokenCycleEdge[];
};

export type PointReviewOperation =
  | { op: "delete"; point_id: string }
  | { op: "add"; point: Pick<ReviewPoint, "id" | "title"> };

export type DependencyReviewOperation = {
  op: "add" | "remove";
  dependent_id: string;
  prerequisite_id: string;
  reason: string;
};

export type ReviewOperation = PointReviewOperation | DependencyReviewOperation;

export type ReviewSubmitBody = {
  conversation_id: string;
  revision: number;
  artifact_hash: string;
  operations: ReviewOperation[];
};

export type ReviewSubmitResult = {
  review: ReviewResource;
  resumeMessage: string;
  displayContent: string;
};

export type ReviewSubmissionNavigation = {
  reviewId: string;
  conversationId: string;
  resumeMessage: string;
  displayContent: string;
};

export class InvalidReviewPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewPayloadError";
  }
}

export function parseReviewPointer(value: unknown): ReviewPointer | null {
  const candidate = unwrapReviewCandidate(value);
  if (!isRecord(candidate)) return null;

  const id = readNonEmptyString(candidate.id);
  const kind = readReviewKind(candidate.kind);
  const gate = readNonEmptyString(candidate.gate);
  const status = readNonEmptyString(candidate.status);
  const revision = readRevision(candidate.revision);
  const artifactHash = readNonEmptyString(candidate.artifact_hash);
  const conversationId = readNonEmptyString(candidate.conversation_id);
  const courseId = readNonEmptyString(candidate.course_id);
  const courseTitle = readNonEmptyString(candidate.course_title);
  if (
    !id
    || !kind
    || !gate
    || !status
    || revision === null
    || !artifactHash
    || !conversationId
    || !courseId
    || !courseTitle
  ) {
    return null;
  }

  const reviewUrl = readNonEmptyString(candidate.review_url);
  const resumeMessage = readNonEmptyString(candidate.resume_message);
  const displayContent = readNonEmptyString(candidate.display_content);
  return {
    id,
    kind,
    gate,
    status,
    revision,
    artifact_hash: artifactHash,
    conversation_id: conversationId,
    course_id: courseId,
    course_title: courseTitle,
    summary: parseSummary(candidate.summary),
    ...(reviewUrl ? { review_url: reviewUrl } : {}),
    ...(typeof candidate.resume_pending === "boolean" ? { resume_pending: candidate.resume_pending } : {}),
    ...(resumeMessage ? { resume_message: resumeMessage } : {}),
    ...(displayContent ? { display_content: displayContent } : {}),
  };
}

export function reviewResumeNavigation(review: ReviewPointer): ReviewSubmissionNavigation | null {
  if (!review.resume_pending || !review.resume_message || !review.display_content) return null;
  return {
    reviewId: review.id,
    conversationId: review.conversation_id,
    resumeMessage: review.resume_message,
    displayContent: review.display_content,
  };
}

export function parseReviewResource(value: unknown): ReviewResource {
  const candidate = unwrapReviewCandidate(value);
  const pointer = parseReviewPointer(candidate);
  if (!pointer || !isRecord(candidate)) {
    throw new InvalidReviewPayloadError("审核数据缺少必要的身份、版本或课程信息");
  }

  const points = parsePoints(candidate.points);
  const pointIds = new Set(points.map((point) => point.id));
  return {
    ...pointer,
    points,
    review_queue: parseReviewQueue(candidate.review_queue),
    edges: parseEdges(candidate.edges, "依赖关系", pointIds),
    related_pairs: parseRelatedPairs(candidate.related_pairs, pointIds),
    broken_cycle_edges: parseBrokenCycleEdges(candidate.broken_cycle_edges, pointIds),
  };
}

export function relatedPairKey(firstId: string, secondId: string) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

export function isReviewReadOnly(status: string) {
  const normalized = status.trim().toLowerCase().replaceAll("_", "-");
  if (["pending", "open", "unresolved", "awaiting-review", "draft"].includes(normalized)) {
    return false;
  }
  return true;
}

export function reviewKindLabel(kind: ReviewKind) {
  return kind === "knowledge-points" ? "知识点审核" : "先修关系审核";
}

function parsePoints(value: unknown): ReviewPoint[] {
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError("审核数据中的 points 必须是数组");
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new InvalidReviewPayloadError(`第 ${index + 1} 个知识点格式无效`);
    }
    const id = readNonEmptyString(item.id);
    const title = readNonEmptyString(item.title);
    if (!id || !title) {
      throw new InvalidReviewPayloadError(`第 ${index + 1} 个知识点缺少 id 或 title`);
    }
    if (seen.has(id)) {
      throw new InvalidReviewPayloadError(`审核数据包含重复知识点 ID：${id}`);
    }
    seen.add(id);
    return {
      id,
      title,
      ...optionalString("shortSummary", item.short_summary ?? item.shortSummary),
      ...optionalString("difficulty", item.difficulty),
      ...optionalNumber("importance", item.importance),
      keyTerms: readStringArray(item.key_terms ?? item.keyTerms),
      ...optionalString("kind", item.kind),
      ...optionalNumber("confidence", item.confidence),
      ...optionalString("scopeStatus", item.scope_status ?? item.scopeStatus),
      issues: parsePointIssues(item.issues, id),
      clusterIds: readStringArray(item.cluster_ids ?? item.clusterIds),
      ...optionalString("role", item.role),
    };
  });
}

function parseReviewQueue(value: unknown): ReviewQueueItem[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === "string" && item.trim()) {
        return { pointId: item.trim() };
      }
      if (!isRecord(item)) {
        throw new InvalidReviewPayloadError(`review_queue 第 ${index + 1} 项格式无效`);
      }
      const pointId = readNonEmptyString(item.point_id)
        ?? readNonEmptyString(item.pointId)
        ?? readNonEmptyString(item.id);
      return parseReviewIssue(item, pointId ?? undefined)[0] ?? {};
    });
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([pointId, issues]) => {
      if (Array.isArray(issues)) {
        return issues.flatMap((issue) => parseReviewIssue(issue, pointId));
      }
      return parseReviewIssue(issues, pointId);
    });
  }
  throw new InvalidReviewPayloadError("审核数据中的 review_queue 必须是数组或对象");
}

function parseEdges(value: unknown, label: string, pointIds: Set<string>): ReviewEdge[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError(`审核数据中的 ${label} 必须是数组`);
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    const edge = parseEdge(item, `${label}第 ${index + 1} 项`);
    if (!pointIds.has(edge.dependentId) || !pointIds.has(edge.prerequisiteId)) {
      throw new InvalidReviewPayloadError(
        `${label}引用了未知知识点：${edge.prerequisiteId} -> ${edge.dependentId}`,
      );
    }
    const key = edgeKey(edge.dependentId, edge.prerequisiteId);
    if (seen.has(key)) {
      throw new InvalidReviewPayloadError(
        `${label}包含重复关系：${edge.prerequisiteId} -> ${edge.dependentId}`,
      );
    }
    seen.add(key);
    return edge;
  });
}

function parseBrokenCycleEdges(value: unknown, pointIds: Set<string>): BrokenCycleEdge[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError("审核数据中的 broken_cycle_edges 必须是数组");
  }

  return value.map((item, index) => {
    const edge = parseEdge(item, `断环记录第 ${index + 1} 项`);
    if (!pointIds.has(edge.dependentId) || !pointIds.has(edge.prerequisiteId)) {
      throw new InvalidReviewPayloadError(
        `断环记录引用了未知知识点：${edge.prerequisiteId} -> ${edge.dependentId}`,
      );
    }
    const cycleId = isRecord(item)
      ? readNonEmptyString(item.cycle_id) ?? readNonEmptyString(item.cycleId)
      : null;
    return { ...edge, ...(cycleId ? { cycleId } : {}) };
  });
}

function parseRelatedPairs(value: unknown, pointIds: Set<string>): ReviewRelatedPair[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError("审核数据中的 related_pairs 必须是数组");
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new InvalidReviewPayloadError(`related_pairs 第 ${index + 1} 项格式无效`);
    }
    const firstId = readNonEmptyString(item.first_id) ?? readNonEmptyString(item.firstId);
    const secondId = readNonEmptyString(item.second_id) ?? readNonEmptyString(item.secondId);
    if (!firstId || !secondId || firstId === secondId) {
      throw new InvalidReviewPayloadError(`related_pairs 第 ${index + 1} 项缺少有效知识点对`);
    }
    if (!pointIds.has(firstId) || !pointIds.has(secondId)) {
      throw new InvalidReviewPayloadError(
        `related_pairs 引用了未知知识点：${firstId} / ${secondId}`,
      );
    }
    const key = relatedPairKey(firstId, secondId);
    if (seen.has(key)) {
      throw new InvalidReviewPayloadError(`related_pairs 包含重复知识点对：${firstId} / ${secondId}`);
    }
    seen.add(key);
    return firstId < secondId
      ? { firstId, secondId }
      : { firstId: secondId, secondId: firstId };
  });
}

function parseEdge(value: unknown, label: string): ReviewEdge {
  if (!isRecord(value)) {
    throw new InvalidReviewPayloadError(`${label}格式无效`);
  }
  const dependentId = readNonEmptyString(value.dependent_id)
    ?? readNonEmptyString(value.dependentId)
    ?? readNonEmptyString(value.from);
  const prerequisiteId = readNonEmptyString(value.prerequisite_id)
    ?? readNonEmptyString(value.prerequisiteId)
    ?? readNonEmptyString(value.to);
  if (!dependentId || !prerequisiteId) {
    throw new InvalidReviewPayloadError(`${label}缺少 dependent_id 或 prerequisite_id`);
  }
  if (dependentId === prerequisiteId) {
    throw new InvalidReviewPayloadError(`${label}包含自身依赖：${dependentId}`);
  }
  return {
    dependentId,
    prerequisiteId,
    reason: readNonEmptyString(value.reason) ?? "",
  };
}

function parseSummary(value: unknown): ReviewSummary {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (
      typeof item === "number" && Number.isFinite(item) ? [[key, item]] : []
    )),
  );
}

function parsePointIssues(value: unknown, pointId: string): ReviewIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => parseReviewIssue(item, pointId));
}

function parseReviewIssue(value: unknown, fallbackPointId?: string): ReviewIssue[] {
  if (typeof value === "string" && value.trim()) {
    return [{ ...(fallbackPointId ? { pointId: fallbackPointId } : {}), reason: value.trim() }];
  }
  if (!isRecord(value)) return [];
  const pointId = readNonEmptyString(value.point_id)
    ?? readNonEmptyString(value.pointId)
    ?? readNonEmptyString(value.id)
    ?? fallbackPointId;
  const reason = readNonEmptyString(value.reason)
    ?? readNonEmptyString(value.message);
  return [{
    ...(pointId ? { pointId } : {}),
    ...optionalString("term", value.term),
    ...optionalString("issue", value.issue),
    ...(reason ? { reason } : {}),
    ...optionalString("suggestedAction", value.suggested_action ?? value.suggestedAction),
  }];
}

function unwrapReviewCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.review)) return value.review;
  if (isRecord(value.pending_review)) return value.pending_review;
  if (isRecord(value.pending_review_resume)) return value.pending_review_resume;
  return value;
}

function readRevision(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readReviewKind(value: unknown): ReviewKind | null {
  return value === "knowledge-points" || value === "prerequisites" ? value : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const text = readNonEmptyString(item);
    return text ? [text] : [];
  }))];
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  const text = readNonEmptyString(value);
  return text ? { [key]: text } as Record<Key, string> : {};
}

function optionalNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: value } as Record<Key, number>
    : {};
}

function edgeKey(dependentId: string, prerequisiteId: string) {
  return `${dependentId}\u0000${prerequisiteId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
