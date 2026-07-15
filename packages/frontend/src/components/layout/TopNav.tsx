import { BookOpen, Bot, Home } from "lucide-react";

type TopNavProps = {
  onGoHome: () => void;
  isCatalog: boolean;
};

export function TopNav({ onGoHome, isCatalog }: TopNavProps) {
  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-surface">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onGoHome}
          className="flex items-center gap-3 rounded-lg text-left outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="返回课程导览"
          title="返回课程导览"
        >
          <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-white" />
          </span>
          <h1 className="text-xl font-serif font-semibold text-text-primary">课程知识森林</h1>
        </button>
        <span className="text-xs text-text-secondary ml-2 max-sm:hidden">
          {isCatalog ? "课程导览" : "课程学习空间"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        {isCatalog ? <Home className="w-4 h-4 text-primary" /> : <Bot className="w-4 h-4 text-primary" />}
        <span className="max-sm:hidden">OpenCode Agent</span>
      </div>
    </header>
  );
}
