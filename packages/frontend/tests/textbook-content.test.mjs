import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let contentContract;

before(async () => {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/course/forest/textbookContent.ts";',
      resolveDir: frontendRoot,
      sourcefile: "textbook-content-contract-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const output = result.outputFiles?.[0];
  assert.ok(output);
  contentContract = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  );
});

function sourceSpan(overrides = {}) {
  return {
    materialId: "material-1",
    blockIds: ["source-block-1"],
    headingPath: ["第一章", "基本概念"],
    lineStart: 12,
    lineEnd: 20,
    assetRefs: [],
    excerptSha256: "a".repeat(64),
    ...overrides,
  };
}

test("v2 renderer guard requires the exact schema discriminator and a blocks array", () => {
  assert.equal(contentContract.isTextbookContentV2({
    schema_version: "textbook-content/2.0",
    blocks: [],
  }), true);
  assert.equal(contentContract.isTextbookContentV2({
    schema_version: "textbook-content/1.0",
    blocks: [],
  }), false);
  assert.equal(contentContract.isTextbookContentV2({
    schema_version: "textbook-content/2.0",
    blocks: {},
  }), false);
  assert.equal(contentContract.isTextbookContentV2(undefined), false);
});

test("normalizer preserves valid block order and provenance discriminants", () => {
  const normalized = contentContract.normalizeTextbookContentV2({
    schema_version: "textbook-content/2.0",
    blocks: [
      {
        id: " definition ",
        kind: "definition",
        title: " 定义 ",
        markdown: " **教材定义** ",
        provenance: {
          origin: "textbook",
          representation: "paraphrase",
          sourceSpans: [sourceSpan()],
        },
      },
      {
        id: "example",
        kind: "worked-example",
        markdown: "模型生成的例题",
        provenance: {
          origin: "model",
          basedOnBlockIds: [" definition "],
        },
      },
    ],
  });

  assert.deepEqual(normalized.blocks.map((block) => block.id), ["definition", "example"]);
  assert.equal(normalized.blocks[0].provenance.origin, "textbook");
  assert.equal(normalized.blocks[0].provenance.representation, "paraphrase");
  assert.equal(normalized.blocks[1].provenance.origin, "model");
  assert.deepEqual(normalized.blocks[1].provenance.basedOnBlockIds, ["definition"]);
});

test("normalizer keeps readable blocks while dropping unknown or malformed blocks", () => {
  const normalized = contentContract.normalizeTextbookContentV2({
    schema_version: "textbook-content/2.0",
    blocks: [
      {
        id: "good",
        kind: "formula",
        markdown: "$x + y$",
        provenance: {
          origin: "textbook",
          representation: "quote",
          sourceSpans: [sourceSpan({ page: 3 })],
        },
      },
      {
        id: "future-kind",
        kind: "future-immersive-demo",
        markdown: "unsupported",
        provenance: { origin: "model", basedOnBlockIds: ["good"] },
      },
      {
        id: "missing-location",
        kind: "explanation",
        markdown: "untraceable textbook content",
        provenance: { origin: "textbook", representation: "quote", sourceSpans: [] },
      },
      {
        id: "missing-heading-path",
        kind: "explanation",
        markdown: "a location without a heading path",
        provenance: {
          origin: "textbook",
          representation: "quote",
          sourceSpans: [sourceSpan({ headingPath: [] })],
        },
      },
      null,
    ],
  });

  assert.ok(normalized);
  assert.deepEqual(normalized.blocks.map((block) => block.id), ["good"]);
  assert.equal(normalized.blocks[0].provenance.sourceSpans[0].page, 3);
});

test("legacy content does not normalize into the v2 renderer", () => {
  assert.equal(contentContract.normalizeTextbookContentV2(undefined), null);
  assert.equal(contentContract.normalizeTextbookContentV2({ coreIdea: "legacy" }), null);
});

test("all canonical block kinds have user-facing labels", () => {
  const kinds = [
    "definition", "explanation", "mechanism", "procedure", "formula", "example",
    "worked-example", "comparison", "application", "code", "table", "figure",
    "warning", "misconception", "exercise", "summary", "note", "other",
  ];
  for (const kind of kinds) {
    assert.match(contentContract.textbookContentBlockKindLabel(kind), /\S/);
  }
});

test("textbook Markdown repairs generated literal paragraph breaks conservatively", () => {
  assert.equal(
    contentContract.normalizeTextbookMarkdown("第一段\\n\\n第二段"),
    "第一段\n\n第二段",
  );
  assert.equal(
    contentContract.normalizeTextbookMarkdown("代码中的 \\n 转义不应改写"),
    "代码中的 \\n 转义不应改写",
  );
  assert.equal(
    contentContract.normalizeTextbookMarkdown("已有换行\n以及字面量 \\n\\n"),
    "已有换行\n以及字面量 \\n\\n",
  );
  assert.equal(
    contentContract.normalizeTextbookMarkdown("第一段\\n\\n`代码里的\\n\\n保持原样`\\n\\n第二段"),
    "第一段\n\n`代码里的\\n\\n保持原样`\n\n第二段",
  );
});

test("textbook Markdown converts supported LaTeX delimiters for remark-math", () => {
  assert.equal(
    contentContract.normalizeTextbookMarkdown(
      String.raw`行内 \(x + \delta\)，块公式：

\[
y = \frac{x}{2}
\]`,
    ),
    String.raw`行内 $x + \delta$，块公式：

$$
y = \frac{x}{2}
$$`,
  );
});

test("textbook Markdown leaves code and ordinary backslashes untouched", () => {
  const markdown = [
    "正文 \\(x\\)",
    "",
    "`inline \\(code\\)`",
    "",
    "``multi-line",
    "inline \\(code\\)``",
    "",
    "```text",
    "fenced \\[code\\]",
    "```",
    "",
    "~~~text",
    "tilde \\(code\\)",
    "~~~",
    "",
    "转义字面量 \\\\(ordinary\\\\) 与未闭合 \\(value",
  ].join("\n");
  assert.equal(
    contentContract.normalizeTextbookMarkdown(markdown),
    [
      "正文 $x$",
      "",
      "`inline \\(code\\)`",
      "",
      "``multi-line",
      "inline \\(code\\)``",
      "",
      "```text",
      "fenced \\[code\\]",
      "```",
      "",
      "~~~text",
      "tilde \\(code\\)",
      "~~~",
      "",
      "转义字面量 \\\\(ordinary\\\\) 与未闭合 \\(value",
    ].join("\n"),
  );
});

test("source presentation separates learner location from technical audit fields", () => {
  const span = sourceSpan({ page: 7, assetRefs: ["figure-2.png"] });
  assert.equal(
    contentContract.textbookSourceHeading(span),
    "第一章 › 基本概念",
  );
  assert.equal(
    contentContract.textbookSourceLocator(span),
    "第 7 页 · Markdown 第 12–20 行",
  );
  assert.deepEqual(contentContract.textbookSourceTechnicalDetails(span), {
    materialId: "material-1",
    blockIds: ["source-block-1"],
    assetRefs: ["figure-2.png"],
    excerptSha256: "a".repeat(64),
  });
});
