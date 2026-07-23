import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  LockKeyhole,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { fetchReview, ReviewApiError, submitReview } from "@/features/reviews/api";
import type {
  ReviewKind,
  ReviewOperation,
  ReviewResource,
  ReviewSubmissionNavigation,
} from "@/features/reviews/types";
import {
  isReviewReadOnly,
  reviewKindLabel,
  reviewResumeNavigation,
} from "@/features/reviews/types";
import { KnowledgePointReview } from "./KnowledgePointReview";
import { PrerequisiteReview } from "./PrerequisiteReview";

type ReviewWorkspaceProps = {
  reviewId: string;
  expectedKind: ReviewKind;
  onSubmitted: (result: ReviewSubmissionNavigation) => void;
  onBack: () => void;
};

type ReviewState = {
  phase: "loading" | "ready" | "submitting" | "stale" | "error";
  review: ReviewResource | null;
  error: string;
};

type ReviewAction =
  | { type: "load" }
  | { type: "loaded"; review: ReviewResource }
  | { type: "load-error"; error: string }
  | { type: "submitting" }
  | { type: "submit-error"; error: string }
  | { type: "stale"; error: string };

const INITIAL_STATE: ReviewState = {
  phase: "loading",
  review: null,
  error: "",
};

export function ReviewWorkspace({
  reviewId,
  expectedKind,
  onSubmitted,
  onBack,
}: ReviewWorkspaceProps) {
  const [state, dispatch] = useReducer(reviewReducer, INITIAL_STATE);
  const [reloadVersion, setReloadVersion] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [expectedKind, reviewId]);

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "load" });
    void fetchReview(reviewId, controller.signal)
      .then((review) => {
        if (review.kind !== expectedKind) {
          throw new ReviewApiError(
            `审核链接类型不匹配：当前任务是${reviewKindLabel(review.kind)}`,
          );
        }
        dispatch({ type: "loaded", review });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: "load-error",
          error: error instanceof Error ? error.message : "审核数据加载失败",
        });
      });
    return () => controller.abort();
  }, [expectedKind, reloadVersion, reviewId]);

  const reload = useCallback(() => setReloadVersion((value) => value + 1), []);

  const resumeIfPending = useCallback((review: ReviewResource) => {
    const navigation = reviewResumeNavigation(review);
    if (!navigation) return false;
    onSubmitted(navigation);
    return true;
  }, [onSubmitted]);

  useEffect(() => {
    const review = state.review;
    if (state.phase !== "ready" || !review || review.status.toLowerCase() !== "resolved") return;
    resumeIfPending(review);
  }, [resumeIfPending, state.phase, state.review]);

  const submit = useCallback(async (operations: ReviewOperation[]) => {
    const review = state.review;
    if (!review || state.phase !== "ready" || isReviewReadOnly(review.status)) return;
    dispatch({ type: "submitting" });
    try {
      const result = await submitReview(review.id, {
        conversation_id: review.conversation_id,
        revision: review.revision,
        artifact_hash: review.artifact_hash,
        operations,
      });
      dispatch({ type: "loaded", review: result.review });
      resumeIfPending(result.review);
    } catch (error) {
      const message = error instanceof Error ? error.message : "审核提交失败";
      if (error instanceof ReviewApiError && error.status === 409) {
        dispatch({ type: "stale", error: message });
      } else {
        dispatch({ type: "submit-error", error: message });
      }
    }
  }, [resumeIfPending, state.phase, state.review]);

  if (state.phase === "loading" && !state.review) {
    return (
      <div className="grid h-full place-items-center bg-cream px-6" role="status" aria-live="polite">
        <div className="grid justify-items-center gap-3 text-sm text-text-secondary">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
          正在加载审核数据
        </div>
      </div>
    );
  }

  if (state.phase === "error" || !state.review) {
    return (
      <div className="grid h-full place-items-center bg-cream p-6 text-center">
        <section aria-labelledby="review-load-error" className="grid max-w-md justify-items-center gap-3 rounded-lg border border-error/20 bg-surface p-7 shadow-sm">
          <AlertCircle className="h-7 w-7 text-error" aria-hidden="true" />
          <h1 id="review-load-error" className="text-base font-semibold text-text-primary">无法打开审核任务</h1>
          <p className="text-sm leading-6 text-text-secondary" role="alert">{state.error}</p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-text-secondary hover:bg-cream-dark"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              返回
            </button>
            <button
              type="button"
              onClick={reload}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              重试
            </button>
          </div>
        </section>
      </div>
    );
  }

  const review = state.review;
  const readOnly = isReviewReadOnly(review.status);
  const interactionDisabled = readOnly || state.phase !== "ready";
  const contentKey = `${review.id}:${review.revision}:${review.artifact_hash}`;

  return (
    <section className="flex h-full min-h-0 flex-col bg-cream" aria-labelledby="review-title" aria-busy={state.phase === "submitting"}>
      <header className="shrink-0 border-b border-border bg-surface px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border text-text-secondary transition-colors hover:bg-cream-dark hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            title="返回课程导览"
            aria-label="返回课程导览"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
              <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
                <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {reviewKindLabel(review.kind)}
              </span>
              <span aria-hidden="true">·</span>
              <span>{review.gate}</span>
              <span aria-hidden="true">·</span>
              <span>版本 {review.revision}</span>
            </div>
            <h1 id="review-title" className="mt-1 break-words text-xl font-semibold text-text-primary sm:text-2xl">
              {review.course_title}
            </h1>
          </div>
          <span className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold ${
            readOnly
              ? "border-primary/25 bg-primary-light text-primary"
              : "border-warning/30 bg-amber-50 text-amber-700"
          }`}>
            {readOnly ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />}
            {readOnly ? "已完成" : "待审核"}
          </span>
        </div>
        <ReviewSummary review={review} />
      </header>

      {state.phase === "stale" && (
        <div className="shrink-0 border-b border-warning/30 bg-amber-50 px-4 py-2.5 sm:px-6 lg:px-8" role="alert">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 text-sm text-amber-800">
            <span className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{state.error || "审核数据已经更新，请加载最新版本后重新确认"}</span>
            </span>
            <button
              type="button"
              onClick={reload}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/35 bg-surface px-3 text-xs font-semibold text-amber-800 hover:bg-amber-100"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              加载最新版本
            </button>
          </div>
        </div>
      )}

      {readOnly && (
        <div className="shrink-0 border-b border-primary/20 bg-primary-light/65 px-4 py-2.5 text-sm text-primary sm:px-6 lg:px-8" role="status">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            该审核已提交，当前内容为只读版本。
          </div>
        </div>
      )}

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {review.kind === "knowledge-points" ? (
          <KnowledgePointReview
            key={contentKey}
            review={review}
            disabled={interactionDisabled}
            readOnly={readOnly}
            submitting={state.phase === "submitting"}
            submitError={state.phase === "ready" ? state.error : ""}
            onSubmit={(operations) => void submit(operations)}
          />
        ) : (
          <PrerequisiteReview
            key={contentKey}
            review={review}
            disabled={interactionDisabled}
            readOnly={readOnly}
            submitting={state.phase === "submitting"}
            submitError={state.phase === "ready" ? state.error : ""}
            onSubmit={(operations) => void submit(operations)}
          />
        )}
      </div>
    </section>
  );
}

function ReviewSummary({ review }: { review: ReviewResource }) {
  const metrics = review.kind === "knowledge-points"
    ? [
        ["知识点", review.summary.total ?? review.points.length],
        ["核心范围", review.summary.core],
        ["边界范围", review.summary.boundary],
        ["待复核", review.summary.needs_review ?? review.summary.review_queue],
        ["低置信度", review.summary.low_confidence],
      ] as const
    : [
        ["知识点", review.summary.total_points ?? review.points.length],
        ["先修关系", review.summary.total_edges ?? review.edges.length],
        ["优化关系", review.summary.refined_edges],
        ["断环记录", review.summary.broken_cycles],
      ] as const;
  return (
    <dl className="mx-auto mt-4 flex w-full max-w-6xl flex-wrap gap-x-0 border-y border-border-light">
      {metrics.flatMap(([label, value]) => typeof value === "number" ? [[label, value] as const] : []).map(([label, value]) => (
        <div key={label} className="min-w-24 border-r border-border-light px-3 py-2 first:pl-0 last:border-r-0">
          <dt className="text-[10px] text-text-secondary">{label}</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "load":
      return { phase: "loading", review: state.review, error: "" };
    case "loaded":
      return { phase: "ready", review: action.review, error: "" };
    case "load-error":
      return { phase: "error", review: null, error: action.error };
    case "submitting":
      return { ...state, phase: "submitting", error: "" };
    case "submit-error":
      return { ...state, phase: "ready", error: action.error };
    case "stale":
      return { ...state, phase: "stale", error: action.error };
  }
}
