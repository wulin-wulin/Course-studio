import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let questionPresentation;

before(async () => {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/course/forest/questionPresentation.ts";',
      resolveDir: frontendRoot,
      sourcefile: "question-presentation-contract-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const output = result.outputFiles?.[0];
  assert.ok(output);
  questionPresentation = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  );
});

test("question reading mode requires the explicit presentation marker", () => {
  assert.equal(
    questionPresentation.isQuestionPresentationPoint({ presentationType: "question" }),
    true,
  );
  assert.equal(
    questionPresentation.isQuestionPresentationPoint({ kind: "practice" }),
    false,
  );
  assert.equal(
    questionPresentation.isQuestionPresentationPoint({
      kind: "practice",
      presentationType: "article",
    }),
    false,
  );
  assert.equal(
    questionPresentation.isQuestionBankCourse({ presentationType: "question-bank" }),
    true,
  );
  assert.equal(questionPresentation.isQuestionBankCourse({}), false);
});

test("question prompt removes storage labels and formats options as readable Markdown", () => {
  const prompt = questionPresentation.normalizeQuestionPrompt([
    "【题型】单项选择题",
    "【题干】下面哪一项最合适？",
    "【选项】",
    "A. 第一项",
    "B．第二项",
  ].join("\n"));

  assert.equal(
    prompt,
    "下面哪一项最合适？\n\n**选项**\n\n- **A.** 第一项\n- **B.** 第二项",
  );
  assert.equal(questionPresentation.questionTypeFromPrompt("【题型】单项选择题\n【题干】题目"), "单项选择题");
  assert.equal(
    questionPresentation.normalizeQuestionPrompt(
      "### 题目\n\n请选择最佳答案。\n\n### 选项\n\n- **A.** 第一项",
    ),
    "请选择最佳答案。\n\n### 选项\n\n- **A.** 第一项",
  );
});

test("natural Markdown ability and knowledge cards split title from learner-facing detail", () => {
  assert.deepEqual(
    questionPresentation.normalizeQuestionAbility(
      "**A1 价值与边界判断（重点能力）**：说明人工智能在高等教育中的价值与适用边界。",
    ),
    {
      label: "重点能力",
      title: "A1 价值与边界判断",
      purpose: "说明人工智能在高等教育中的价值与适用边界。",
    },
  );
  assert.deepEqual(
    questionPresentation.normalizeQuestionKnowledge(
      "**双维度框架**：本题用于判断 AI 是教学工具还是素养培养目标。",
    ),
    {
      title: "双维度框架",
      reason: "本题用于判断 AI 是教学工具还是素养培养目标。",
    },
  );
});

test("legacy ability and knowledge fields remain readable without exposing internal IDs", () => {
  const ability = questionPresentation.normalizeQuestionAbility(
    "主能力｜a1-ai-value-boundaries｜A1 能说明人工智能的价值与边界｜训练目的：训练边界判断。",
  );
  const knowledge = questionPresentation.normalizeQuestionKnowledge(
    "知识点｜ai-education-dual-dimension-framework｜人工智能教育双维度框架｜关联：直接｜理由：提供判断依据。",
  );

  assert.deepEqual(ability, {
    label: "主能力",
    title: "A1 能说明人工智能的价值与边界",
    purpose: "训练边界判断。",
  });
  assert.deepEqual(knowledge, {
    title: "人工智能教育双维度框架",
    relation: "直接",
    reason: "提供判断依据。",
  });
  assert.doesNotMatch(JSON.stringify({ ability, knowledge }), /a1-ai-value-boundaries|ai-education-dual-dimension-framework/);
});
