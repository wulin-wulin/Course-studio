import { BookOpen, Bot, ClipboardCheck, Home } from "lucide-react";

type TopNavContext = "catalog" | "course" | "knowledge-points" | "prerequisites";

type TopNavProps = {
  onGoHome: () => void;
  context: TopNavContext;
};

export function TopNav({ onGoHome, context }: TopNavProps) {
  const isCatalog = context === "catalog";
  const isReview = context === "knowledge-points" || context === "prerequisites";
  const contextLabel = context === "catalog"
    ? "课程导览"
    : context === "course"
      ? "课程学习空间"
      : context === "knowledge-points"
        ? "知识点审核"
        : "先修关系审核";

  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-surface">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onGoHome}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="返回课程导览"
          title="返回课程导览"
        >
          <span className="w-8 h-8 shrink-0 rounded-lg bg-primary flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-white" />
          </span>
          <h1 className="truncate text-xl font-serif font-semibold text-text-primary">课程知识森林</h1>
        </button>
        <span className="ml-2 shrink-0 text-xs text-text-secondary max-sm:hidden">
          {contextLabel}
        </span>
      </div>
      <div className="ml-3 flex shrink-0 items-center gap-2 text-xs text-text-secondary">
        {isCatalog ? (
          <Home className="w-4 h-4 text-primary" aria-hidden="true" />
        ) : isReview ? (
          <ClipboardCheck className="w-4 h-4 text-primary" aria-hidden="true" />
        ) : (
          <Bot className="w-4 h-4 text-primary" aria-hidden="true" />
        )}
        <span className="max-sm:hidden">{isReview ? "审核工作区" : "课程助手"}</span>
      </div>
    </header>
  );
}
