import { ArrowRight, ClipboardCheck } from "lucide-react";
import {
  reviewKindLabel,
  type ReviewPointer,
} from "@/features/reviews/types";

export function ReviewRequiredCard({
  review,
  onOpen,
}: {
  review: ReviewPointer;
  onOpen: () => void;
}) {
  return (
    <section className="rounded-xl border border-primary/25 bg-primary-light/65 p-3 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-white">
          <ClipboardCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-primary">等待你的审核</p>
          <h3 className="mt-0.5 text-sm font-semibold text-text-primary">
            {reviewKindLabel(review.kind)}
          </h3>
          <p className="mt-1 truncate text-xs text-text-secondary">
            {review.course_title}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-primary-hover"
      >
        打开审核页
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </section>
  );
}
