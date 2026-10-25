import {
  TEXTBOOK_CONTENT_V2_SCHEMA,
  type ForestSourceSpan,
  type TextbookContentBlock,
  type TextbookContentBlockKind,
  type TextbookContentBlockProvenance,
  type TextbookLearningAsset,
  type TextbookLearningAssetFallback,
  type TextbookLearningCompletion,
  type TextbookLearningDepth,
  type TextbookLearningDesign,
  type TextbookLearningModule,
  type TextbookLearningOutcome,
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

const LEARNING_DEPTHS = new Set<TextbookLearningDepth>(["core", "support", "advanced"]);
const ADAPTATION_LEVELS = new Set(["faithful", "balanced", "teaching-first"] as const);

type TextbookContentV2Envelope = {
  schema_version: typeof TEXTBOOK_CONTENT_V2_SCHEMA;
  blocks: unknown[];
  learningDesign?: unknown;
  learningAssets?: unknown;
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
  const learningDesign = normalizeTextbookLearningDesign(value.learningDesign);
  const learningAssets = normalizeTextbookLearningAssets(value.learningAssets);
  return {
    schema_version: TEXTBOOK_CONTENT_V2_SCHEMA,
    blocks: value.blocks.flatMap((block) => {
      const normalized = normalizeBlock(block);
      if (!normalized || blockIds.has(normalized.id)) return [];
      blockIds.add(normalized.id);
      return [normalized];
    }),
    ...(learningDesign ? { learningDesign } : {}),
    ...(learningAssets.length > 0 ? { learningAssets } : {}),
  };
}

/**
 * Reads optional teaching metadata without making it part of the v2 validity
 * boundary. Malformed future metadata is ignored while the grounded blocks
 * remain readable.
 */
export function normalizeTextbookLearningDesign(value: unknown): TextbookLearningDesign | null {
  if (!isRecord(value)) return null;
  const primaryPattern = readOptionalString(value.primaryPattern);
  const adaptationLevel = typeof value.adaptationLevel === "string"
    && ADAPTATION_LEVELS.has(value.adaptationLevel as "faithful" | "balanced" | "teaching-first")
    ? value.adaptationLevel as "faithful" | "balanced" | "teaching-first"
    : undefined;
  const editorialPolicy = readOptionalString(value.editorialPolicy);
  const estimatedMinutes = typeof value.estimatedMinutes === "number"
    && Number.isFinite(value.estimatedMinutes)
    && value.estimatedMinutes > 0
    ? Math.round(value.estimatedMinutes)
    : undefined;
  const outcomes = normalizeLearningOutcomes(value.outcomes);
  const misconceptions = normalizeOptionalStringArray(value.misconceptions);
  const modules = normalizeLearningModules(value.modules);
  const completion = normalizeLearningCompletion(value.completion);
  const design: TextbookLearningDesign = {
    ...(primaryPattern ? { primaryPattern } : {}),
    ...(adaptationLevel ? { adaptationLevel } : {}),
    ...(editorialPolicy ? { editorialPolicy } : {}),
    ...(estimatedMinutes ? { estimatedMinutes } : {}),
    ...(outcomes.length > 0 ? { outcomes } : {}),
    ...(misconceptions.length > 0 ? { misconceptions } : {}),
    ...(modules.length > 0 ? { modules } : {}),
    ...(completion ? { completion } : {}),
  };
  if (Object.keys(design).length === 0) return null;
  return design.adaptationLevel ? design : { ...design, adaptationLevel: "balanced" };
}

export function normalizeTextbookLearningAssets(value: unknown): TextbookLearningAsset[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((candidate) => {
    const asset = normalizeLearningAsset(candidate);
    if (!asset || ids.has(asset.id)) return [];
    ids.add(asset.id);
    return [asset];
  });
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

/** Splits an exercise's final reference path so learners can attempt it first. */
export function splitTextbookExerciseReference(markdown: string): { prompt: string; reference?: string } {
  const marker = /(?:^|\n)(?:\*\*)?参考路径[：:](?:\*\*)?[ \t]*/gu;
  let lastMatch: RegExpExecArray | null = null;
  for (let match = marker.exec(markdown); match; match = marker.exec(markdown)) lastMatch = match;
  if (!lastMatch || lastMatch.index === undefined) return { prompt: markdown };
  const reference = markdown.slice(lastMatch.index + lastMatch[0].length).trim();
  if (!reference) return { prompt: markdown };
  return {
    prompt: markdown.slice(0, lastMatch.index).trim(),
    reference,
  };
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
  const moduleId = readOptionalString(value.moduleId);
  const depth = typeof value.depth === "string" && LEARNING_DEPTHS.has(value.depth as TextbookLearningDepth)
    ? value.depth as TextbookLearningDepth
    : undefined;
  return {
    id: value.id.trim(),
    kind: value.kind as TextbookContentBlockKind,
    ...(typeof value.title === "string" ? { title: value.title.trim() } : {}),
    markdown: value.markdown.trim(),
    provenance,
    ...(moduleId ? { moduleId } : {}),
    ...(depth ? { depth } : {}),
  };
}

function normalizeLearningOutcomes(value: unknown): TextbookLearningOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (isNonEmptyString(candidate)) return [{ text: candidate.trim() }];
    if (!isRecord(candidate) || !isNonEmptyString(candidate.text)) return [];
    const id = readOptionalString(candidate.id);
    return [{ ...(id ? { id } : {}), text: candidate.text.trim() }];
  });
}

function normalizeLearningModules(value: unknown): TextbookLearningModule[] {
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => {
      const module = normalizeLearningModule(candidate);
      return module ? [module] : [];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([id, candidate]) => {
    const module = normalizeLearningModule(candidate, id);
    return module ? [module] : [];
  });
}

function normalizeLearningModule(value: unknown, fallbackId?: string): TextbookLearningModule | null {
  if (isNonEmptyString(value) && isNonEmptyString(fallbackId)) {
    return { id: fallbackId.trim(), title: value.trim() };
  }
  if (!isRecord(value)) return null;
  const id = readOptionalString(value.id) ?? (isNonEmptyString(fallbackId) ? fallbackId.trim() : undefined);
  const title = readOptionalString(value.title);
  if (!id || !title) return null;
  const role = readOptionalString(value.role);
  const description = readOptionalString(value.description);
  const outcomeRefs = normalizeOptionalStringArray(value.outcomeRefs);
  const order = Number.isInteger(value.order) && (value.order as number) >= 0
    ? value.order as number
    : undefined;
  return {
    id,
    title,
    ...(role ? { role } : {}),
    ...(description ? { description } : {}),
    ...(outcomeRefs.length > 0 ? { outcomeRefs } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function normalizeLearningCompletion(value: unknown): TextbookLearningCompletion | null {
  if (!isRecord(value)) return null;
  const outcomeRefs = normalizeOptionalStringArray(value.outcomeRefs);
  const method = readOptionalString(value.method);
  const successCriteria = normalizeOptionalStringArray(value.successCriteria);
  const exerciseBlockId = readOptionalString(value.exerciseBlockId);
  const summaryBlockId = readOptionalString(value.summaryBlockId);
  const nextPointId = readOptionalString(value.nextPointId);
  const completion: TextbookLearningCompletion = {
    ...(outcomeRefs.length > 0 ? { outcomeRefs } : {}),
    ...(method ? { method } : {}),
    ...(successCriteria.length > 0 ? { successCriteria } : {}),
    ...(exerciseBlockId ? { exerciseBlockId } : {}),
    ...(summaryBlockId ? { summaryBlockId } : {}),
    ...(nextPointId ? { nextPointId } : {}),
  };
  return Object.keys(completion).length > 0 ? completion : null;
}

function normalizeLearningAsset(value: unknown): TextbookLearningAsset | null {
  if (!isRecord(value)) return null;
  const id = readOptionalString(value.id);
  const type = readOptionalString(value.type);
  const anchorBlockId = readOptionalString(value.anchorBlockId);
  if (!id || !type || !anchorBlockId) return null;
  const title = readOptionalString(value.title);
  const animationType = readOptionalString(value.animationType)
    ?? readOptionalString(value.runtimeType)
    ?? readOptionalString(value.assetId);
  const learningPurpose = readOptionalString(value.learningPurpose);
  const caption = readOptionalString(value.caption);
  const moduleId = readOptionalString(value.moduleId);
  const depth = typeof value.depth === "string" && LEARNING_DEPTHS.has(value.depth as TextbookLearningDepth)
    ? value.depth as TextbookLearningDepth
    : undefined;
  const outcomeRefs = normalizeOptionalStringArray(value.outcomeRefs);
  const config = normalizeLearningAssetConfig(value.config);
  const grounding = normalizeLearningAssetGrounding(value.grounding);
  const fallback = normalizeLearningAssetFallback(value.fallback);
  return {
    id,
    type,
    anchorBlockId,
    ...(title ? { title } : {}),
    ...(animationType ? { animationType } : {}),
    ...(learningPurpose ? { learningPurpose } : {}),
    ...(caption ? { caption } : {}),
    ...(moduleId ? { moduleId } : {}),
    ...(depth ? { depth } : {}),
    ...(outcomeRefs.length > 0 ? { outcomeRefs } : {}),
    ...(config ? { config } : {}),
    ...(grounding ? { grounding } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

function normalizeLearningAssetFallback(value: unknown): TextbookLearningAssetFallback | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const type = readOptionalString(value.type);
  const mode = readOptionalString(value.mode);
  const markdown = readOptionalString(value.markdown);
  const caption = readOptionalString(value.caption);
  const content = readOptionalString(value.content);
  const blockId = readOptionalString(value.blockId);
  if (!type && !mode && !markdown && !caption && !content && !blockId) return null;
  return {
    ...(type ? { type } : {}),
    ...(mode ? { mode } : {}),
    ...(markdown ? { markdown } : {}),
    ...(caption ? { caption } : {}),
    ...(content ? { content } : {}),
    ...(blockId ? { blockId } : {}),
  };
}

function normalizeLearningAssetConfig(value: unknown): TextbookLearningAsset["config"] | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  return { ...value };
}

function normalizeLearningAssetGrounding(value: unknown): TextbookLearningAsset["grounding"] | null {
  if (!isRecord(value)) return null;
  const basedOnBlockIds = normalizeOptionalStringArray(value.basedOnBlockIds);
  return basedOnBlockIds.length > 0 ? { basedOnBlockIds } : null;
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

function normalizeOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNonEmptyString).map((item) => item.trim());
}

function readOptionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
