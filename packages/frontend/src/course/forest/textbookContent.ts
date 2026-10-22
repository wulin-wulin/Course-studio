import {
  TEXTBOOK_CONTENT_V2_SCHEMA,
  type ForestSourceSpan,
  type TextbookContentBlock,
  type TextbookContentBlockKind,
  type TextbookContentBlockProvenance,
  type TextbookPointContentV2,
} from "./types";

const BLOCK_KINDS = new Set<TextbookContentBlockKind>([
  "definition",
  "explanation",
  "mechanism",
  "procedure",
  "formula",
  "example",
  "worked-example",
  "comparison",
  "application",
  "code",
  "table",
  "figure",
  "warning",
  "misconception",
  "exercise",
  "summary",
  "note",
  "other",
]);

type TextbookContentV2Envelope = {
  schema_version: typeof TEXTBOOK_CONTENT_V2_SCHEMA;
  blocks: unknown[];
};

/**
 * Selects the v2 renderer without making legacy payloads opt in accidentally.
 * Individual blocks are normalized separately so one malformed future block
 * cannot make an otherwise readable point fail.
 */
export function isTextbookContentV2(value: unknown): value is TextbookContentV2Envelope {
  return isRecord(value)
    && value.schema_version === TEXTBOOK_CONTENT_V2_SCHEMA
    && Array.isArray(value.blocks);
}

export function normalizeTextbookContentV2(value: unknown): TextbookPointContentV2 | null {
  if (!isTextbookContentV2(value)) return null;
  const blockIds = new Set<string>();
  return {
    schema_version: TEXTBOOK_CONTENT_V2_SCHEMA,
    blocks: value.blocks.flatMap((block) => {
      const normalized = normalizeBlock(block);
      if (!normalized || blockIds.has(normalized.id)) return [];
      blockIds.add(normalized.id);
      return [normalized];
    }),
  };
}

export function textbookContentBlockKindLabel(kind: TextbookContentBlockKind): string {
  const labels: Record<TextbookContentBlockKind, string> = {
    definition: "概念定义",
    explanation: "教材讲解",
    mechanism: "工作机制",
    procedure: "步骤与方法",
    formula: "公式与推导",
    example: "示例",
    "worked-example": "例题解析",
    comparison: "对比辨析",
    application: "应用场景",
    code: "代码示例",
    table: "表格",
    figure: "图示",
    warning: "注意事项",
    misconception: "常见误区",
    exercise: "练习",
    summary: "小结",
    note: "补充说明",
    other: "扩展内容",
  };
  return labels[kind];
}

/**
 * Normalizes model-authored textbook Markdown at the renderer boundary.
 *
 * Generated JSON occasionally contains visible `\\n\\n` paragraph markers or
 * LaTeX's `\\(...\\)` / `\\[...\\]` delimiters. `remark-math` only recognizes
 * `$...$` / `$$...$$`, so the latter would otherwise render as raw commands.
 * Fenced and inline code are kept byte-for-byte because their backslashes are
 * examples rather than Markdown control syntax.
 */
export function normalizeTextbookMarkdown(value: string): string {
  const repairLiteralParagraphs = !value.includes("\n") && /\\n\\n/.test(value);
  return mapMarkdownProse(value, (prose) => {
    const paragraphs = repairLiteralParagraphs
      ? prose.replace(/\\r\\n|\\n|\\r/g, "\n")
      : prose;
    return normalizeLatexMathDelimiters(paragraphs);
  });
}

function mapMarkdownProse(value: string, transform: (prose: string) => string): string {
  let output = "";
  let prose = "";
  let cursor = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const flushProse = () => {
    output += mapInlineCodeProse(prose, transform);
    prose = "";
  };

  while (cursor < value.length) {
    const newline = value.indexOf("\n", cursor);
    const lineEnd = newline >= 0 ? newline + 1 : value.length;
    const line = value.slice(cursor, lineEnd);
    const fenceRun = readFenceRun(line);

    if (fence) {
      output += line;
      if (
        fenceRun
        && fenceRun.marker === fence.marker
        && fenceRun.length >= fence.length
        && fenceRun.closing
      ) {
        fence = null;
      }
    } else if (fenceRun) {
      flushProse();
      output += line;
      fence = { marker: fenceRun.marker, length: fenceRun.length };
    } else {
      prose += line;
    }
    cursor = lineEnd;
  }

  flushProse();
  return output;
}

function readFenceRun(line: string): {
  marker: "`" | "~";
  length: number;
  closing: boolean;
} | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*?)(?:\r?\n|$)/.exec(line);
  if (!match) return null;
  const run = match[1]!;
  const suffix = match[2] ?? "";
  return {
    marker: run[0] as "`" | "~",
    length: run.length,
    closing: suffix.trim().length === 0,
  };
}

function mapInlineCodeProse(value: string, transform: (prose: string) => string): string {
  let output = "";
  let proseStart = 0;
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] !== "`" || isEscaped(value, cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (value[runEnd] === "`") runEnd += 1;
    const marker = value.slice(cursor, runEnd);
    const closing = findBacktickRun(value, marker, runEnd);
    if (closing < 0) {
      cursor = runEnd;
      continue;
    }
    output += transform(value.slice(proseStart, cursor));
    const codeEnd = closing + marker.length;
    output += value.slice(cursor, codeEnd);
    proseStart = codeEnd;
    cursor = codeEnd;
  }

  return output + transform(value.slice(proseStart));
}

function findBacktickRun(value: string, marker: string, from: number): number {
  let cursor = from;
  while (cursor < value.length) {
    const found = value.indexOf(marker, cursor);
    if (found < 0) return -1;
    if (
      !isEscaped(value, found)
      && value[found - 1] !== "`"
      && value[found + marker.length] !== "`"
    ) {
      return found;
    }
    cursor = found + marker.length;
  }
  return -1;
}

function normalizeLatexMathDelimiters(value: string): string {
  const delimiters = [
    { open: "\\(", close: "\\)", replacement: "$" },
    { open: "\\[", close: "\\]", replacement: "$$" },
  ] as const;
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const candidates = delimiters
      .map((delimiter) => ({
        delimiter,
        index: findUnescaped(value, delimiter.open, cursor),
      }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => left.index - right.index);
    const candidate = candidates[0];
    if (!candidate) break;

    const contentStart = candidate.index + candidate.delimiter.open.length;
    const closing = findUnescaped(value, candidate.delimiter.close, contentStart);
    if (closing < 0) {
      output += value.slice(cursor, contentStart);
      cursor = contentStart;
      continue;
    }

    output += value.slice(cursor, candidate.index);
    output += candidate.delimiter.replacement;
    output += value.slice(contentStart, closing);
    output += candidate.delimiter.replacement;
    cursor = closing + candidate.delimiter.close.length;
  }

  return output + value.slice(cursor);
}

function findUnescaped(value: string, needle: string, from: number): number {
  let cursor = from;
  while (cursor < value.length) {
    const found = value.indexOf(needle, cursor);
    if (found < 0 || !isEscaped(value, found)) return found;
    cursor = found + needle.length;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function textbookSourceHeading(span: ForestSourceSpan): string {
  return span.headingPath.join(" › ") || "教材来源";
}

export function textbookSourceLocator(span: ForestSourceSpan): string {
  const parts: string[] = [];
  if (span.page !== undefined) parts.push(`第 ${span.page} 页`);
  parts.push(`Markdown 第 ${span.lineStart}–${span.lineEnd} 行`);
  return parts.join(" · ");
}

export function textbookSourceTechnicalDetails(span: ForestSourceSpan) {
  return {
    materialId: span.materialId,
    blockIds: [...span.blockIds],
    assetRefs: [...span.assetRefs],
    excerptSha256: span.excerptSha256,
  };
}

function normalizeBlock(value: unknown): TextbookContentBlock | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.markdown)) return null;
  if (typeof value.kind !== "string" || !BLOCK_KINDS.has(value.kind as TextbookContentBlockKind)) return null;
  if (value.title !== undefined && !isNonEmptyString(value.title)) return null;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return null;
  return {
    id: value.id.trim(),
    kind: value.kind as TextbookContentBlockKind,
    ...(typeof value.title === "string" ? { title: value.title.trim() } : {}),
    markdown: value.markdown.trim(),
    provenance,
  };
}

function normalizeProvenance(value: unknown): TextbookContentBlockProvenance | null {
  if (!isRecord(value)) return null;
  const sourceSpans = normalizeSourceSpans(value.sourceSpans);
  if (value.origin === "textbook") {
    if (value.representation !== "quote" && value.representation !== "paraphrase") return null;
    if (!sourceSpans || sourceSpans.length === 0) return null;
    return {
      origin: "textbook",
      representation: value.representation,
      sourceSpans,
    };
  }
  if (value.origin === "model") {
    if (
      !Array.isArray(value.basedOnBlockIds)
      || value.basedOnBlockIds.length === 0
      || !value.basedOnBlockIds.every(isNonEmptyString)
    ) return null;
    return {
      origin: "model",
      basedOnBlockIds: value.basedOnBlockIds.map((id) => id.trim()),
      ...(sourceSpans && sourceSpans.length > 0 ? { sourceSpans } : {}),
    };
  }
  return null;
}

function normalizeSourceSpans(value: unknown): ForestSourceSpan[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const spans = value.flatMap((span) => {
    if (!isForestSourceSpan(span)) return [];
    return [{
      materialId: span.materialId.trim(),
      blockIds: span.blockIds.map((id) => id.trim()),
      headingPath: span.headingPath.map((heading) => heading.trim()),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      ...(typeof span.page === "number" ? { page: span.page } : {}),
      assetRefs: span.assetRefs.map((asset) => asset.trim()),
      excerptSha256: span.excerptSha256.trim(),
    }];
  });
  return spans.length === value.length ? spans : null;
}

function isForestSourceSpan(value: unknown): value is ForestSourceSpan {
  return isRecord(value)
    && isNonEmptyString(value.materialId)
    && isNonEmptyStringArray(value.blockIds)
    && value.blockIds.length > 0
    && isNonEmptyStringArray(value.headingPath)
    && value.headingPath.length > 0
    && Number.isInteger(value.lineStart)
    && (value.lineStart as number) >= 1
    && Number.isInteger(value.lineEnd)
    && (value.lineEnd as number) >= 1
    && (value.lineEnd as number) >= (value.lineStart as number)
    && (value.page === undefined || (Number.isInteger(value.page) && (value.page as number) >= 1))
    && isNonEmptyStringArray(value.assetRefs)
    && typeof value.excerptSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.excerptSha256);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
