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

test("normalizer preserves optional teaching modules, depth, design, and anchored assets", () => {
  const normalized = contentContract.normalizeTextbookContentV2({
    schema_version: "textbook-content/2.0",
    learningDesign: {
      primaryPattern: "quantitative-mechanism",
      adaptationLevel: "balanced",
      editorialPolicy: "围绕学习目标重排教材内容",
      estimatedMinutes: 11.6,
      outcomes: ["建立量化直觉", { id: "calculate", text: "计算量化间隔" }],
      modules: {
        intuition: {
          role: "explanation",
          title: "先建立直觉",
          outcomeRefs: ["calculate"],
          order: 0,
        },
        practice: "完成一次配置选择",
      },
      completion: {
        outcomeRefs: ["calculate"],
        method: "完成配置练习",
        successCriteria: ["能解释位数与量程的取舍"],
        exerciseBlockId: "advanced-note",
        summaryBlockId: "definition",
        nextPointId: "point-next",
      },
    },
    learningAssets: [
      {
        id: "quantization-lab",
        type: "interactive-simulation",
        anchorBlockId: "definition",
        animationType: "adc-quantization",
        learningPurpose: "调节位数并观察量化阶梯",
        moduleId: "intuition",
        depth: "support",
        outcomeRefs: ["calculate"],
        config: {
          preset: { rangeMin: -40, rangeMax: 60, adcBits: 16 },
          controls: ["adcBits", "range"],
          outputs: ["quantizationStep", "noiseRatio"],
        },
        grounding: { basedOnBlockIds: ["definition"] },
        fallback: {
          type: "step-diagram",
          mode: "static",
          markdown: "静态阶梯图",
          content: "位数与量化间隔对照",
          blockId: "definition",
        },
      },
    ],
    blocks: [
      {
        id: "definition",
        kind: "definition",
        moduleId: "intuition",
        depth: "core",
        markdown: "量化把连续输入映射为离散码值。",
        provenance: {
          origin: "textbook",
          representation: "paraphrase",
          sourceSpans: [sourceSpan()],
        },
      },
      {
        id: "advanced-note",
        kind: "note",
        moduleId: "intuition",
        depth: "advanced",
        markdown: "进一步讨论有效位数。",
        provenance: { origin: "model", basedOnBlockIds: ["definition"] },
      },
    ],
  });

  assert.ok(normalized);
  assert.equal(normalized.blocks[0].moduleId, "intuition");
  assert.equal(normalized.blocks[1].depth, "advanced");
  assert.equal(normalized.learningDesign.adaptationLevel, "balanced");
  assert.equal(normalized.learningDesign.editorialPolicy, "围绕学习目标重排教材内容");
  assert.equal(normalized.learningDesign.estimatedMinutes, 12);
  assert.deepEqual(normalized.learningDesign.modules.map((module) => module.id), ["intuition", "practice"]);
  assert.deepEqual(normalized.learningDesign.modules[0].outcomeRefs, ["calculate"]);
  assert.equal(normalized.learningDesign.modules[0].order, 0);
  assert.deepEqual(normalized.learningDesign.completion, {
    outcomeRefs: ["calculate"],
    method: "完成配置练习",
    successCriteria: ["能解释位数与量程的取舍"],
    exerciseBlockId: "advanced-note",
    summaryBlockId: "definition",
    nextPointId: "point-next",
  });
  assert.deepEqual(normalized.learningDesign.outcomes, [
    { text: "建立量化直觉" },
    { id: "calculate", text: "计算量化间隔" },
  ]);
  assert.equal(normalized.learningAssets[0].anchorBlockId, "definition");
  assert.equal(normalized.learningAssets[0].animationType, "adc-quantization");
  assert.equal(normalized.learningAssets[0].moduleId, "intuition");
  assert.equal(normalized.learningAssets[0].depth, "support");
  assert.deepEqual(normalized.learningAssets[0].config.controls, ["adcBits", "range"]);
  assert.deepEqual(normalized.learningAssets[0].config.outputs, ["quantizationStep", "noiseRatio"]);
  assert.deepEqual(normalized.learningAssets[0].grounding.basedOnBlockIds, ["definition"]);
  assert.equal(normalized.learningAssets[0].fallback.blockId, "definition");
  assert.equal(normalized.learningAssets[0].fallback.mode, "static");
  assert.equal(normalized.learningAssets[0].fallback.content, "位数与量化间隔对照");
});

test("malformed optional teaching metadata never invalidates readable v2 blocks", () => {
  const normalized = contentContract.normalizeTextbookContentV2({
    schema_version: "textbook-content/2.0",
    learningDesign: { estimatedMinutes: -3, outcomes: [null], modules: "invalid" },
    learningAssets: [{ id: "missing-anchor", type: "animation" }],
    blocks: [
      {
        id: "good",
        kind: "explanation",
        moduleId: " ",
        depth: "future-depth",
        markdown: "仍应显示",
        provenance: {
          origin: "textbook",
          representation: "quote",
          sourceSpans: [sourceSpan()],
        },
      },
    ],
  });

  assert.deepEqual(normalized.blocks.map((block) => block.id), ["good"]);
  assert.equal(normalized.blocks[0].moduleId, undefined);
  assert.equal(normalized.blocks[0].depth, undefined);
  assert.equal(normalized.learningDesign, undefined);
  assert.equal(normalized.learningAssets, undefined);
});

test("a readable learning design defaults its editorial intensity to balanced", () => {
  assert.deepEqual(
    contentContract.normalizeTextbookLearningDesign({ primaryPattern: "concept-example-check" }),
    { primaryPattern: "concept-example-check", adaptationLevel: "balanced" },
  );
  assert.equal(contentContract.normalizeTextbookLearningDesign({ estimatedMinutes: -1 }), null);
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

test("exercise reference paths are separated only at the final marker", () => {
  assert.deepEqual(
    contentContract.splitTextbookExerciseReference(
      "先独立完成判断。\n\n中途可以讨论参考路径的含义。\n\n**参考路径：** 先计算量化间隔，再比较噪声。",
    ),
    {
      prompt: "先独立完成判断。\n\n中途可以讨论参考路径的含义。",
      reference: "先计算量化间隔，再比较噪声。",
    },
  );
  assert.deepEqual(
    contentContract.splitTextbookExerciseReference("这里只是提到参考路径，不应拆分。"),
    { prompt: "这里只是提到参考路径，不应拆分。" },
  );
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
