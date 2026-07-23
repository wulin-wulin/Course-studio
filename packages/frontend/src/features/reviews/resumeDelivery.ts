import {
  InvalidReviewPayloadError,
  parseReviewPointer,
  reviewResumeNavigation,
} from "./types";
import type {
  ReviewPointer,
  ReviewSubmissionNavigation,
} from "./types";

export const REVIEW_RESUME_AVAILABLE_EVENT = "course-review-resume-available";
export const REVIEW_RESUME_OUTBOX_KEY =
  "course-studio:review-resume-outbox:v1";

const OUTBOX_SCHEMA = "course-review-resume-outbox/1.0";
const MAX_ITEMS = 20;

type ResumeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class ReviewResumeOutbox {
  private memoryItems: ReviewSubmissionNavigation[] = [];
  private storageFailed = false;

  constructor(private readonly storage: ResumeStorage | null = null) {}

  list(): ReviewSubmissionNavigation[] {
    if (!this.storage || this.storageFailed) return [...this.memoryItems];
    try {
      const raw = this.storage.getItem(REVIEW_RESUME_OUTBOX_KEY);
      if (raw === null) {
        this.memoryItems = [];
        return [];
      }
      const value: unknown = JSON.parse(raw);
      if (
        !isRecord(value) ||
        value.schema !== OUTBOX_SCHEMA ||
        !Array.isArray(value.items)
      ) {
        this.memoryItems = [];
        return [];
      }
      const items: ReviewSubmissionNavigation[] = [];
      const seen = new Set<string>();
      for (const candidate of value.items.slice(-MAX_ITEMS)) {
        const item = parseNavigation(candidate);
        if (!item || seen.has(item.reviewId)) continue;
        seen.add(item.reviewId);
        items.push(item);
      }
      this.memoryItems = items;
      return [...items];
    } catch {
      this.memoryItems = [];
      return [];
    }
  }

  enqueue(value: ReviewSubmissionNavigation) {
    const item = parseNavigation(value);
    if (!item) throw new TypeError("审核恢复任务格式无效");
    const next = [
      ...this.list().filter((candidate) => candidate.reviewId !== item.reviewId),
      item,
    ].slice(-MAX_ITEMS);
    this.persist(next);
    return item;
  }

  remove(reviewId: string) {
    if (!reviewId.trim()) return;
    this.persist(this.list().filter((item) => item.reviewId !== reviewId));
  }

  removeConversation(conversationId: string) {
    if (!conversationId.trim()) return;
    this.persist(
      this.list().filter((item) => item.conversationId !== conversationId)
    );
  }

  private persist(items: ReviewSubmissionNavigation[]) {
    this.memoryItems = [...items];
    if (!this.storage || this.storageFailed) return;
    try {
      if (items.length === 0) {
        this.storage.removeItem(REVIEW_RESUME_OUTBOX_KEY);
      } else {
        this.storage.setItem(
          REVIEW_RESUME_OUTBOX_KEY,
          JSON.stringify({ schema: OUTBOX_SCHEMA, items }),
        );
      }
    } catch {
      this.storageFailed = true;
    }
  }
}

let browserOutbox: ReviewResumeOutbox | null = null;

export function getBrowserReviewResumeOutbox() {
  if (!browserOutbox) browserOutbox = new ReviewResumeOutbox(readBrowserStorage());
  return browserOutbox;
}

export function queueReviewResume(
  navigation: ReviewSubmissionNavigation,
  outbox = getBrowserReviewResumeOutbox(),
  notify: (() => void) | null = notifyBrowser,
) {
  const queued = outbox.enqueue(navigation);
  notify?.();
  return queued;
}

export type ActiveReviewResume = {
  reviewId: string;
  conversationId: string;
};

export function reviewResumeDeliveryOutcome(
  active: ActiveReviewResume,
  event: { type: string; payload?: Record<string, unknown> },
): "consumed" | "failed" | null {
  const payload = event.payload ?? {};
  const conversationId = readNonEmptyString(payload.conversation_id);
  if (conversationId && conversationId !== active.conversationId) return null;
  if (event.type === "agent_review_resolved") {
    const nested = isRecord(payload.review) ? payload.review : {};
    const reviewId =
      readNonEmptyString(payload.review_id) ??
      readNonEmptyString(payload.id) ??
      readNonEmptyString(nested.id);
    return reviewId === active.reviewId ? "consumed" : null;
  }
  if (event.type === "agent_error") return "failed";
  if (event.type !== "agent_done") return null;
  const code = Number(payload.return_code);
  return Number.isFinite(code) && code !== 0 ? "failed" : null;
}

export type ReviewResumeReconciliation =
  | { kind: "retry"; navigation: ReviewSubmissionNavigation }
  | { kind: "pending-review"; review: ReviewPointer }
  | { kind: "consumed" };

export function reconcileReviewResume(
  reviewId: string,
  conversation: unknown,
): ReviewResumeReconciliation {
  if (!isRecord(conversation)) {
    throw new InvalidReviewPayloadError("历史会话响应格式无效");
  }
  if (
    conversation.pending_review !== null &&
    conversation.pending_review !== undefined
  ) {
    const review = parseReviewPointer(conversation.pending_review);
    if (!review) {
      throw new InvalidReviewPayloadError("历史会话中的待审核任务格式无效");
    }
    return { kind: "pending-review", review };
  }
  if (
    conversation.pending_review_resume === null ||
    conversation.pending_review_resume === undefined
  ) {
    return { kind: "consumed" };
  }
  const pointer = parseReviewPointer(conversation.pending_review_resume);
  if (!pointer) {
    throw new InvalidReviewPayloadError("历史会话中的审核恢复任务格式无效");
  }
  const navigation = reviewResumeNavigation(pointer);
  if (!navigation || navigation.reviewId !== reviewId) {
    return { kind: "consumed" };
  }
  return { kind: "retry", navigation };
}

const RETRY_DELAYS = [
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

export function reviewResumeRetryDelay(failureCount: number) {
  if (!Number.isInteger(failureCount) || failureCount < 0) return null;
  return RETRY_DELAYS[failureCount] ?? null;
}

export function reviewResumeRetryWindowMs() {
  return RETRY_DELAYS.slice(1).reduce((sum, delay) => sum + delay, 0);
}

function parseNavigation(value: unknown): ReviewSubmissionNavigation | null {
  if (!isRecord(value)) return null;
  const reviewId = readNonEmptyString(value.reviewId);
  const conversationId = readNonEmptyString(value.conversationId);
  const resumeMessage = readNonEmptyString(value.resumeMessage);
  const displayContent = readNonEmptyString(value.displayContent);
  if (!reviewId || !conversationId || !resumeMessage || !displayContent) return null;
  return { reviewId, conversationId, resumeMessage, displayContent };
}

function readBrowserStorage(): ResumeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyBrowser() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(REVIEW_RESUME_AVAILABLE_EVENT));
  }
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
