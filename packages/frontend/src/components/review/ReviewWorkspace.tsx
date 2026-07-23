import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { fetchReview, ReviewApiError, submitReview } from "@/features/reviews/api";
import {
  isReviewReadOnly,
  reviewKindLabel,
  reviewResumeNavigation,
  type ReviewKind,
  type ReviewOperation,
  type ReviewResource,
  type ReviewSubmissionNavigation,
} from "@/features/reviews/types";
import { KnowledgeGraphReview } from "./KnowledgeGraphReview";
import { KnowledgePointReview } from "./KnowledgePointReview";

type Props = {
  reviewId: string;
  expectedKind: ReviewKind;
  onSubmitted: (result: ReviewSubmissionNavigation) => void;
  onBack: () => void;
};

type State = {
  phase: "loading" | "ready" | "submitting" | "stale" | "error";
  review: ReviewResource | null;
  error: string;
};

type Action =
  | { type: "load" }
  | { type: "loaded"; review: ReviewResource }
  | { type: "load-error"; error: string }
  | { type: "submitting" }
  | { type: "submit-error"; error: string }
  | { type: "stale"; error: string };

const INITIAL_STATE: State = { phase: "loading", review: null, error: "" };
const REVIEW_SUBMIT_TIMEOUT_MS = 120_000;

export function ReviewWorkspace({
  reviewId,
  expectedKind,
  onSubmitted,
  onBack,
}: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [reloadVersion, setReloadVersion] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    const controller = new AbortController();
    dispatch({ type: "load" });
    void fetchReview(reviewId, controller.signal)
      .then((review) => {
        if (review.kind !== expectedKind) {
          throw new ReviewApiError(
            `审核类型不匹配：当前任务是${reviewKindLabel(review.kind)}`,
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

  useEffect(() => {
    if (state.phase !== "ready" || !state.review) return;
    const navigation = reviewResumeNavigation(state.review);
    if (navigation) onSubmitted(navigation);
  }, [onSubmitted, state.phase, state.review]);

  const submit = useCallback(
    async (operations: ReviewOperation[]) => {
      const review = state.review;
      if (
        !review ||
        state.phase !== "ready" ||
        isReviewReadOnly(review.status)
      ) {
        return;
      }
      dispatch({ type: "submitting" });
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        REVIEW_SUBMIT_TIMEOUT_MS,
      );
      try {
        const result = await submitReview(review.id, {
          conversation_id: review.conversation_id,
          revision: review.revision,
          artifact_hash: review.artifact_hash,
          operations,
        }, controller.signal);
        dispatch({ type: "loaded", review: result.review });
        onSubmitted({
          reviewId: review.id,
          conversationId: review.conversation_id,
          resumeMessage: result.resumeMessage,
          displayContent: result.displayContent,
        });
      } catch (error) {
        const message = controller.signal.aborted
          ? "审核提交等待超时，当前进度仍然保留。请检查连接后重新提交。"
          : error instanceof Error
            ? error.message
            : "审核提交失败";
        if (error instanceof ReviewApiError && error.status === 409) {
          dispatch({ type: "stale", error: message });
        } else {
          dispatch({ type: "submit-error", error: message });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [onSubmitted, state.phase, state.review],
  );

  if (state.phase === "loading" && !state.review) {
    return (
      <div className="grid h-full place-items-center bg-cream" role="status">
        <div className="grid justify-items-center gap-3 text-sm text-text-secondary">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          正在加载结构化审核
        </div>
      </div>
    );
  }

  if (state.phase === "error" || !state.review) {
    return (
      <div className="grid h-full place-items-center bg-cream p-6 text-center">
        <section className="grid max-w-md justify-items-center gap-3 rounded-xl border border-error/20 bg-surface p-7 shadow-sm">
          <AlertCircle className="h-7 w-7 text-error" />
          <h1 className="font-semibold text-text-primary">无法打开审核任务</h1>
          <p className="text-sm text-text-secondary" role="alert">{state.error}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm"
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>
            <button
              type="button"
              onClick={() => setReloadVersion((value) => value + 1)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-white"
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </button>
          </div>
        </section>
      </div>
    );
  }

  const review = state.review;
  const readOnly = isReviewReadOnly(review.status);
  const disabled = readOnly || state.phase !== "ready";
  const key = `${review.id}:${review.revision}:${review.artifact_hash}`;

  return (
    <section className="flex h-full min-h-0 flex-col bg-cream" aria-busy={state.phase === "submitting"}>
      <header className="shrink-0 border-b border-border bg-surface px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="grid h-9 w-9 place-items-center rounded-md border border-border text-text-secondary hover:bg-cream-dark"
            aria-label="返回课程生成现场"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
              <ClipboardCheck className="h-3.5 w-3.5" />
              {reviewKindLabel(review.kind)} · {review.gate} · 版本 {review.revision}
            </p>
            <h1 className="mt-1 truncate text-xl font-semibold text-text-primary">
              {review.course_title}
            </h1>
          </div>
          <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${
            readOnly
              ? "border-primary/25 bg-primary-light text-primary"
              : "border-warning/30 bg-amber-50 text-amber-700"
          }`}>
            {readOnly ? "已完成" : "等待你的确认"}
          </span>
        </div>
        <ReviewSummary review={review} />
      </header>

      {state.phase === "stale" && (
        <div className="shrink-0 border-b border-warning/30 bg-amber-50 px-4 py-2.5" role="alert">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 text-sm text-amber-800">
            <span className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4" />
              {state.error || "审核数据已更新，请重新加载最新版本"}
            </span>
            <button
              type="button"
              onClick={() => setReloadVersion((value) => value + 1)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/35 bg-surface px-3 text-xs font-semibold"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              加载最新版本
            </button>
          </div>
        </div>
      )}

      {readOnly && (
        <div className="shrink-0 border-b border-primary/20 bg-primary-light/65 px-5 py-2.5 text-sm text-primary">
          <span className="mx-auto flex max-w-6xl items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            审核已经提交，当前内容为只读版本。
          </span>
        </div>
      )}

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        {review.kind === "knowledge-points" ? (
          <KnowledgePointReview
            key={key}
            review={review}
            disabled={disabled}
            readOnly={readOnly}
            submitting={state.phase === "submitting"}
            submitError={state.phase === "ready" ? state.error : ""}
            onSubmit={(operations) => void submit(operations)}
          />
        ) : (
          <KnowledgeGraphReview
            key={key}
            review={review}
            disabled={disabled}
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
  const metrics =
    review.kind === "knowledge-points"
      ? [
          ["知识点", review.summary.total ?? review.points.length],
          ["待复核", review.summary.needs_review ?? review.summary.review_queue],
        ]
      : [
          ["知识簇", review.summary.total_clusters ?? review.clusters.length],
          ["知识点", review.summary.total_points ?? review.points.length],
          [
            "先修关系",
            review.summary.total_prerequisites ??
              review.points.reduce((sum, point) => sum + point.prerequisites.length, 0),
          ],
        ];
  return (
    <dl className="mx-auto mt-4 flex max-w-6xl flex-wrap border-y border-border-light">
      {metrics.flatMap(([label, value]) =>
        typeof value === "number" ? [[label, value] as const] : [],
      ).map(([label, value]) => (
        <div key={label} className="min-w-24 border-r border-border-light px-3 py-2 first:pl-0">
          <dt className="text-[10px] text-text-secondary">{label}</dt>
          <dd className="text-sm font-semibold text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function reducer(state: State, action: Action): State {
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
