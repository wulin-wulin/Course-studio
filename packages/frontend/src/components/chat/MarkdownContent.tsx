import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import "katex/dist/katex.min.css";

type MarkdownContentProps = {
  content: string;
  className?: string;
};

type HastElement = NonNullable<ExtraProps["node"]>;
type HastNode = HastElement["children"][number];

// 排版与代码高亮配色都在 global.css 的 .markdown-content 中定义，调用处只需追加场景类名。
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={`markdown-content min-w-0 max-w-full overflow-hidden break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
        components={{
          // 只有 pre > code 才是代码块；行内 code 保持默认渲染，样式由 CSS 负责。
          pre({ node, children }) {
            const block = readCodeBlock(node);
            if (!block) return <pre>{children}</pre>;
            const language = block.language ?? "text";
            return (
              <SyntaxHighlighter
                language={language}
                useInlineStyles={false}
                // 显式传入，避免组件默认把 Prism 浅色主题的内联样式（含白色 text-shadow）写到 code 上。
                codeTagProps={{ className: `language-${language}` }}
              >
                {block.text.replace(/\n$/, "")}
              </SyntaxHighlighter>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function readCodeBlock(pre: HastElement | undefined) {
  const code = pre?.children.find(
    (child): child is HastElement => child.type === "element" && child.tagName === "code",
  );
  if (!code) return null;
  const classNames = code.properties.className;
  const languageClass = Array.isArray(classNames)
    ? classNames.map(String).find((name) => name.startsWith("language-"))
    : undefined;
  return {
    language: languageClass?.slice("language-".length) || undefined,
    text: collectText(code),
  };
}

function collectText(node: HastNode): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(collectText).join("");
  return "";
}
