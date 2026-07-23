import { ArrowRight, ClipboardCheck } from "lucide-react";
import type { ReviewPointer } from "@/features/reviews/types";
import { reviewKindLabel } from "@/features/reviews/types";

type ReviewRequiredCardProps = {
  review: ReviewPointer;
  onOpen: () => void;
};

export function ReviewRequiredCard({ review, onOpen }: ReviewRequiredCardProps) {
  const primaryCount = review.kind === "knowledge-points"
    ? review.summary.total
    : review.summary.total_edges;
  const countLabel = review.kind === "knowledge-points" ? "个知识点" : "条先修关系";

  return (
    <section
      aria-labelledby={`review-required-${review.id}`}
      className="rounded-xl border border-primary/25 bg-primary-light/65 p-3 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-white">
          <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-primary">等待你的审核</p>
          <h3
            id={`review-required-${review.id}`}
            className="mt-0.5 truncate text-sm font-semibold text-text-primary"
          >
            {reviewKindLabel(review.kind)}
          </h3>
          <p className="mt-1 truncate text-xs text-text-secondary">{review.course_title}</p>
          {typeof primaryCount === "number" && (
            <p className="mt-1 text-[11px] text-text-secondary">
              当前共 {primaryCount} {countLabel}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        打开审核页
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </section>
  );
}
