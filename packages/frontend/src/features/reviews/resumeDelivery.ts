import {
  InvalidReviewPayloadError,
  parseReviewPointer,
  reviewResumeNavigation,
} from "./types";
import type { ReviewPointer, ReviewSubmissionNavigation } from "./types";

export const REVIEW_RESUME_AVAILABLE_EVENT = "course-review-resume-available";
export const REVIEW_RESUME_OUTBOX_KEY = "course-studio:review-resume-outbox:v1";

const REVIEW_RESUME_OUTBOX_SCHEMA = "course-review-resume-outbox/1.0";
const MAX_REVIEW_RESUME_OUTBOX_ITEMS = 20;

type ReviewResumeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type ReviewResumeOutboxDocument = {
  schema: typeof REVIEW_RESUME_OUTBOX_SCHEMA;
  items: ReviewSubmissionNavigation[];
};

/**
 * A submitted review must outlive the review route and the AgentPanel that
 * happens to be mounted at that instant. The server remains authoritative;
 * this browser outbox only remembers which durable server resume should be
 * reconciled until the server confirms that it was consumed.
 */
export class ReviewResumeOutbox {
  private memoryItems: ReviewSubmissionNavigation[] = [];
  private storageFailed = false;

  constructor(private readonly storage: ReviewResumeStorage | null = null) {}

  list(): ReviewSubmissionNavigation[] {
    if (!this.storage || this.storageFailed) return [...this.memoryItems];
    let raw: string | null;
    try {
      raw = this.storage.getItem(REVIEW_RESUME_OUTBOX_KEY);
    } catch {
      this.storageFailed = true;
      return [...this.memoryItems];
    }
    if (raw === null) {
      this.memoryItems = [];
      return [];
    }
    try {
      const items = parseOutboxDocument(JSON.parse(raw));
      this.memoryItems = items;
      return [...items];
    } catch {
      // A stale or manually edited value must not disable future persistence.
      // Treat it as empty so the next enqueue can repair the document.
      this.memoryItems = [];
      return [];
    }
  }

  enqueue(value: ReviewSubmissionNavigation): ReviewSubmissionNavigation {
    const item = parseReviewResumeNavigation(value);
    if (!item) throw new TypeError("审核恢复任务格式无效");
    const current = this.list().filter((candidate) => candidate.reviewId !== item.reviewId);
    const next = [...current, item].slice(-MAX_REVIEW_RESUME_OUTBOX_ITEMS);
    this.persist(next);
    return item;
  }

  remove(reviewId: string) {
    const normalizedReviewId = readNonEmptyString(reviewId);
    if (!normalizedReviewId) return;
    const next = this.list().filter((item) => item.reviewId !== normalizedReviewId);
    this.persist(next);
  }

  private persist(items: ReviewSubmissionNavigation[]) {
    this.memoryItems = [...items];
    if (!this.storage || this.storageFailed) return;
    try {
      if (items.length === 0) {
        this.storage.removeItem(REVIEW_RESUME_OUTBOX_KEY);
        return;
      }
      const document: ReviewResumeOutboxDocument = {
        schema: REVIEW_RESUME_OUTBOX_SCHEMA,
        items,
      };
      this.storage.setItem(REVIEW_RESUME_OUTBOX_KEY, JSON.stringify(document));
    } catch {
      this.storageFailed = true;
    }
  }
}

let browserReviewResumeOutbox: ReviewResumeOutbox | null = null;

export function getBrowserReviewResumeOutbox() {
  if (browserReviewResumeOutbox === null) {
    browserReviewResumeOutbox = new ReviewResumeOutbox(readBrowserStorage());
  }
  return browserReviewResumeOutbox;
}

export function queueReviewResume(
  navigation: ReviewSubmissionNavigation,
  outbox = getBrowserReviewResumeOutbox(),
  notify: (() => void) | null = notifyBrowserReviewResumeAvailable,
) {
  const queued = outbox.enqueue(navigation);
  notify?.();
  return queued;
}

export type ActiveReviewResume = {
  reviewId: string;
  conversationId: string;
};

export type ReviewResumeDeliveryOutcome = "consumed" | "failed" | null;

// The server keeps a resume claim for at most 120 seconds after a crashed
// worker. The sparse schedule therefore spans slightly longer than that lease
// while remaining finite and avoiding a tight retry loop.
const REVIEW_RESUME_RETRY_DELAYS = [
  350,
  350,
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  30_000,
  45_000,
] as const;

export type ReviewResumeReconciliation =
  | { kind: "retry"; navigation: ReviewSubmissionNavigation }
  | { kind: "pending-review"; review: ReviewPointer }
  | { kind: "consumed" };

type AgentEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export function reviewResumeDeliveryOutcome(
  active: ActiveReviewResume,
  event: AgentEvent,
): ReviewResumeDeliveryOutcome {
  const payload = event.payload ?? {};
  const conversationId = readNonEmptyString(payload.conversation_id);
  if (conversationId && conversationId !== active.conversationId) return null;

  if (event.type === "agent_review_resolved") {
    const nestedReview = isRecord(payload.review) ? payload.review : undefined;
    const reviewId = readNonEmptyString(payload.review_id)
      ?? readNonEmptyString(payload.id)
      ?? readNonEmptyString(nestedReview?.id);
    return reviewId === active.reviewId ? "consumed" : null;
  }

  if (event.type === "agent_error") return "failed";
  if (event.type !== "agent_done") return null;

  const returnCode = Number(payload.return_code);
  if (!Number.isFinite(returnCode)) return null;
  return returnCode === 0 ? null : "failed";
}

export function reconcileReviewResume(
  reviewId: string,
  conversation: unknown,
): ReviewResumeReconciliation {
  if (!isRecord(conversation)) {
    throw new InvalidReviewPayloadError("历史会话响应格式无效");
  }

  if (conversation.pending_review !== null && conversation.pending_review !== undefined) {
    const pendingReview = parseReviewPointer(conversation.pending_review);
    if (!pendingReview) {
      throw new InvalidReviewPayloadError("历史会话中的待审核任务格式无效");
    }
    return { kind: "pending-review", review: pendingReview };
  }

  if (
    conversation.pending_review_resume === null
    || conversation.pending_review_resume === undefined
  ) {
    return { kind: "consumed" };
  }

  const pendingResume = parseReviewPointer(conversation.pending_review_resume);
  if (!pendingResume) {
    throw new InvalidReviewPayloadError("历史会话中的审核恢复任务格式无效");
  }
  const navigation = reviewResumeNavigation(pendingResume);
  if (!navigation || navigation.reviewId !== reviewId) return { kind: "consumed" };
  return { kind: "retry", navigation };
}

export function reviewResumeRetryDelay(failureCount: number) {
  if (!Number.isInteger(failureCount) || failureCount < 0) return null;
  return REVIEW_RESUME_RETRY_DELAYS[failureCount] ?? null;
}

export function reviewResumeRetryWindowMs() {
  // Index zero handles a send that failed before the server could respond.
  // Server-side failures start at index one.
  return REVIEW_RESUME_RETRY_DELAYS.slice(1).reduce((total, delay) => total + delay, 0);
}

function parseOutboxDocument(value: unknown): ReviewSubmissionNavigation[] {
  if (!isRecord(value) || value.schema !== REVIEW_RESUME_OUTBOX_SCHEMA || !Array.isArray(value.items)) {
    throw new TypeError("审核恢复 outbox 格式无效");
  }
  const items: ReviewSubmissionNavigation[] = [];
  const seen = new Set<string>();
  for (const valueItem of value.items.slice(-MAX_REVIEW_RESUME_OUTBOX_ITEMS)) {
    const item = parseReviewResumeNavigation(valueItem);
    if (!item || seen.has(item.reviewId)) continue;
    seen.add(item.reviewId);
    items.push(item);
  }
  return items;
}

function parseReviewResumeNavigation(value: unknown): ReviewSubmissionNavigation | null {
  if (!isRecord(value)) return null;
  const reviewId = readNonEmptyString(value.reviewId);
  const conversationId = readNonEmptyString(value.conversationId);
  const resumeMessage = readNonEmptyString(value.resumeMessage);
  const displayContent = readNonEmptyString(value.displayContent);
  if (!reviewId || !conversationId || !resumeMessage || !displayContent) return null;
  return { reviewId, conversationId, resumeMessage, displayContent };
}

function readBrowserStorage(): ReviewResumeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyBrowserReviewResumeAvailable() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REVIEW_RESUME_AVAILABLE_EVENT));
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
