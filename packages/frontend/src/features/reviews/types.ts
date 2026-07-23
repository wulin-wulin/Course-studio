export type ReviewKind = "knowledge-points" | "knowledge-graph";

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

export type ReviewIssue = {
  pointId?: string;
  term?: string;
  issue?: string;
  reason?: string;
  suggestedAction?: string;
};

export type ReviewCluster = {
  id: string;
  title: string;
  description?: string;
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
  prerequisites: string[];
  related: string[];
  role?: string;
};

export type ReviewResource = ReviewPointer & {
  clusters: ReviewCluster[];
  points: ReviewPoint[];
  review_queue: ReviewIssue[];
};

export type PointReviewOperation =
  | { op: "delete"; point_id: string }
  | { op: "add"; point: Pick<ReviewPoint, "id" | "title"> };

export type GraphReviewOperation =
  | { op: "set-clusters"; point_id: string; cluster_ids: string[] }
  | {
      op: "add-prerequisite" | "remove-prerequisite";
      point_id: string;
      prerequisite_id: string;
      reason: string;
    };

export type ReviewOperation = PointReviewOperation | GraphReviewOperation;

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
    !id ||
    !kind ||
    !gate ||
    !status ||
    revision === null ||
    !artifactHash ||
    !conversationId ||
    !courseId ||
    !courseTitle
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
    ...(typeof candidate.resume_pending === "boolean"
      ? { resume_pending: candidate.resume_pending }
      : {}),
    ...(resumeMessage ? { resume_message: resumeMessage } : {}),
    ...(displayContent ? { display_content: displayContent } : {}),
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
  const clusters = parseClusters(candidate.clusters);
  const clusterIds = new Set(clusters.map((cluster) => cluster.id));

  for (const point of points) {
    for (const clusterId of point.clusterIds) {
      if (!clusterIds.has(clusterId)) {
        throw new InvalidReviewPayloadError(
          `知识点 ${point.id} 引用了未知知识簇：${clusterId}`,
        );
      }
    }
    for (const prerequisiteId of point.prerequisites) {
      if (!pointIds.has(prerequisiteId) || prerequisiteId === point.id) {
        throw new InvalidReviewPayloadError(
          `知识点 ${point.id} 包含无效先修关系：${prerequisiteId}`,
        );
      }
    }
    for (const relatedId of point.related) {
      if (!pointIds.has(relatedId) || relatedId === point.id) {
        throw new InvalidReviewPayloadError(
          `知识点 ${point.id} 包含无效 related 关系：${relatedId}`,
        );
      }
    }
  }

  return {
    ...pointer,
    clusters,
    points,
    review_queue: parseReviewQueue(candidate.review_queue),
  };
}

export function reviewResumeNavigation(
  review: ReviewPointer,
): ReviewSubmissionNavigation | null {
  if (!review.resume_pending || !review.resume_message || !review.display_content) {
    return null;
  }
  return {
    reviewId: review.id,
    conversationId: review.conversation_id,
    resumeMessage: review.resume_message,
    displayContent: review.display_content,
  };
}

export function isReviewReadOnly(status: string) {
  const normalized = status.trim().toLowerCase().replaceAll("_", "-");
  return !["pending", "open", "unresolved", "awaiting-review", "draft"].includes(
    normalized,
  );
}

export function reviewKindLabel(kind: ReviewKind) {
  return kind === "knowledge-points" ? "知识点审核" : "知识图谱审核";
}

export type DependencyEdge = {
  pointId: string;
  prerequisiteId: string;
};

export function findDependencyCycle(
  pointIds: string[],
  edges: DependencyEdge[],
): string[] | null {
  const adjacency = new Map(pointIds.map((pointId) => [pointId, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.pointId)?.push(edge.prerequisiteId);
  }
  const states = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (pointId: string): string[] | null => {
    states.set(pointId, 1);
    positions.set(pointId, stack.length);
    stack.push(pointId);
    for (const prerequisiteId of adjacency.get(pointId) ?? []) {
      if ((states.get(prerequisiteId) ?? 0) === 0) {
        const cycle = visit(prerequisiteId);
        if (cycle) return cycle;
      } else if (states.get(prerequisiteId) === 1) {
        return [
          ...stack.slice(positions.get(prerequisiteId) ?? 0),
          prerequisiteId,
        ];
      }
    }
    stack.pop();
    positions.delete(pointId);
    states.set(pointId, 2);
    return null;
  };

  for (const pointId of pointIds) {
    if ((states.get(pointId) ?? 0) === 0) {
      const cycle = visit(pointId);
      if (cycle) return cycle;
    }
  }
  return null;
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
      prerequisites: readStringArray(item.prerequisites),
      related: readStringArray(item.related),
      ...optionalString("role", item.role),
    };
  });
}

function parseClusters(value: unknown): ReviewCluster[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError("审核数据中的 clusters 必须是数组");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new InvalidReviewPayloadError(`第 ${index + 1} 个知识簇格式无效`);
    }
    const id = readNonEmptyString(item.id);
    const title = readNonEmptyString(item.title);
    if (!id || !title || seen.has(id)) {
      throw new InvalidReviewPayloadError(`第 ${index + 1} 个知识簇缺少唯一 id 或 title`);
    }
    seen.add(id);
    return {
      id,
      title,
      ...optionalString("description", item.description),
    };
  });
}

function parseReviewQueue(value: unknown): ReviewIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidReviewPayloadError("审核数据中的 review_queue 必须是数组");
  }
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ reason: item.trim() }];
    if (!isRecord(item)) return [];
    return parseReviewIssue(item);
  });
}

function parsePointIssues(value: unknown, pointId: string) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => parseReviewIssue(item, pointId));
}

function parseReviewIssue(value: unknown, fallbackPointId?: string): ReviewIssue[] {
  if (typeof value === "string" && value.trim()) {
    return [{ ...(fallbackPointId ? { pointId: fallbackPointId } : {}), reason: value.trim() }];
  }
  if (!isRecord(value)) return [];
  const pointId =
    readNonEmptyString(value.point_id) ??
    readNonEmptyString(value.pointId) ??
    fallbackPointId;
  return [{
    ...(pointId ? { pointId } : {}),
    ...optionalString("term", value.term),
    ...optionalString("issue", value.issue),
    ...optionalString("reason", value.reason ?? value.message),
    ...optionalString(
      "suggestedAction",
      value.suggested_action ?? value.suggestedAction,
    ),
  }];
}

function unwrapReviewCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.review)) return value.review;
  if (isRecord(value.pending_review)) return value.pending_review;
  if (isRecord(value.pending_review_resume)) return value.pending_review_resume;
  return value;
}

function readReviewKind(value: unknown): ReviewKind | null {
  if (value === "knowledge-points") return value;
  if (value === "knowledge-graph" || value === "prerequisites") {
    return "knowledge-graph";
  }
  return null;
}

function readRevision(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const text = readNonEmptyString(item);
    return text ? [text] : [];
  }))];
}

function parseSummary(value: unknown): ReviewSummary {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "number" && Number.isFinite(item) ? [[key, item]] : [],
    ),
  );
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const text = readNonEmptyString(value);
  return text ? ({ [key]: text } as Record<Key, string>) : {};
}

function optionalNumber<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as Record<Key, number>)
    : {};
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
