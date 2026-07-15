import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type CollapsibleContentProps = {
  content: string;
  maxChars?: number;
  maxLines?: number;
  previewClassName?: string;
  buttonClassName?: string;
  renderContent?: (content: string) => ReactNode;
};

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_MAX_LINES = 18;

export function CollapsibleContent({
  content,
  maxChars = DEFAULT_MAX_CHARS,
  maxLines = DEFAULT_MAX_LINES,
  previewClassName = "whitespace-pre-wrap break-words",
  buttonClassName = "mt-2",
  renderContent,
}: CollapsibleContentProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(
    () => makePreview(content, maxChars, maxLines),
    [content, maxChars, maxLines]
  );

  if (!preview.truncated) {
    return <>{renderContent ? renderContent(content) : <div className={previewClassName}>{content}</div>}</>;
  }

  return (
    <div>
      {expanded && renderContent ? (
        renderContent(content)
      ) : (
        <div className={previewClassName}>{preview.text}</div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface/70 px-2 py-1 text-[11px] font-medium text-text-secondary hover:border-primary/30 hover:text-primary transition-colors ${buttonClassName}`}
        title={expanded ? "收起内容" : "展开全部内容"}
      >
        {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <span className="truncate">
          {expanded ? "收起" : `展开全部 · 已省略 ${formatCount(preview.omitted)} 字`}
        </span>
      </button>
    </div>
  );
}

function makePreview(content: string, maxChars: number, maxLines: number) {
  if (content.length <= maxChars) {
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount <= maxLines) {
      return { text: content, truncated: false, omitted: 0 };
    }
  }

  const lines = content.split(/\r?\n/);
  let text = lines.slice(0, maxLines).join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  text = text.trimEnd();

  const omitted = Math.max(0, content.length - text.length);
  return {
    text: text ? `${text}\n...` : "...",
    truncated: omitted > 0,
    omitted,
  };
}

function formatCount(value: number) {
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
