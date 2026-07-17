import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import "katex/dist/katex.min.css";

type MarkdownContentProps = {
  content: string;
  className?: string;
};

export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={`min-w-0 max-w-full overflow-hidden break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const content = String(children);
            const isBlock = Boolean(match) || content.includes("\n");
            if (!isBlock) {
              return (
                <code className="rounded bg-cream-dark px-1 py-0.5 text-xs break-words" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <div className="max-w-full overflow-x-auto">
                <SyntaxHighlighter
                  language={match?.[1] ?? "text"}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    borderRadius: "8px",
                    fontSize: "12px",
                    width: "max-content",
                    minWidth: "100%",
                  }}
                >
                  {content.replace(/\n$/, "")}
                </SyntaxHighlighter>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
