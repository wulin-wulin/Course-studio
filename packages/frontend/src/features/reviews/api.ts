import {
  InvalidReviewPayloadError,
  parseReviewResource,
} from "./types";
import type {
  ReviewResource,
  ReviewSubmitBody,
  ReviewSubmitResult,
} from "./types";

export class ReviewApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ReviewApiError";
    this.status = status;
  }
}

export async function fetchReview(
  reviewId: string,
  signal?: AbortSignal,
): Promise<ReviewResource> {
  const response = await fetch(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}`,
    { cache: "no-store", signal },
  );
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw makeApiError(response.status, payload, "审核数据加载失败");
  }
  try {
    return parseReviewResource(payload);
  } catch (error) {
    throw normalizePayloadError(error);
  }
}

export async function submitReview(
  reviewId: string,
  body: ReviewSubmitBody,
  signal?: AbortSignal,
): Promise<ReviewSubmitResult> {
  const response = await fetch(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw makeApiError(response.status, payload, "审核提交失败");
  }
  if (!isRecord(payload)) {
    throw new ReviewApiError("审核提交成功，但后端响应格式无效");
  }
  const resumeMessage = readNonEmptyString(payload.resume_message);
  const displayContent =
    typeof payload.display_content === "string" ? payload.display_content : null;
  if (!resumeMessage || displayContent === null) {
    throw new ReviewApiError(
      "审核提交响应缺少 resume_message 或 display_content",
    );
  }
  try {
    return {
      review: parseReviewResource(payload.review),
      resumeMessage,
      displayContent,
    };
  } catch (error) {
    throw normalizePayloadError(error);
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function makeApiError(status: number, payload: unknown, fallback: string) {
  const detail = extractErrorDetail(payload);
  return new ReviewApiError(detail || `${fallback}（${status}）`, status);
}

function extractErrorDetail(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (!isRecord(payload)) return "";
  const detail = payload.detail ?? payload.message ?? payload.error;
  if (typeof detail === "string") return detail.trim();
  if (isRecord(detail)) {
    return readNonEmptyString(detail.message) ??
      readNonEmptyString(detail.detail) ??
      "";
  }
  if (Array.isArray(detail)) {
    return detail
      .flatMap((item) => {
        if (!isRecord(item)) return [];
        const message =
          readNonEmptyString(item.msg) ??
          readNonEmptyString(item.message) ??
          readNonEmptyString(item.detail);
        return message ? [message] : [];
      })
      .join("；");
  }
  return "";
}

function normalizePayloadError(error: unknown) {
  if (error instanceof ReviewApiError) return error;
  if (error instanceof InvalidReviewPayloadError) {
    return new ReviewApiError(error.message);
  }
  return new ReviewApiError(
    error instanceof Error ? error.message : "审核响应格式无效",
  );
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
