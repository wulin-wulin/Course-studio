import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { textbookStructureSha256 } from "../skills/knowledge-pipeline-orchestrator/scripts/textbook-structure.mjs";

const SCRIPT = path.resolve("scripts", "validate-textbook-outline.mjs");
const CONTENT_VALIDATOR = path.resolve(
  "skills",
  "candidate-knowledge-point-generator",
  "scripts",
  "validate_output.mjs",
);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function markdownSlice(lines, lineStart, lineEnd) {
  const excerpt = lines.slice(lineStart - 1, lineEnd).join("\n");
  return excerpt + (lineEnd < lines.length ? "\n" : "");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createLargeFixture(root) {
  const courseId = "large-textbook";
  const documentId = "doc-large";
  const courseRoot = path.join(root, "pipeline", courseId);
  const contentRoot = path.join(courseRoot, "course-content");
  const documentRoot = path.join(root, "textbook-input", documentId);
  fs.mkdirSync(documentRoot, { recursive: true });

  const markdownLines = ["# 大规模教材测试"];
  const sections = [];
  const chunks = [];
  const pointSources = [];
  const sourceChapters = [];
  let blockPosition = 0;

  for (let chapterIndex = 0; chapterIndex < 2; chapterIndex += 1) {
    const chapterId = `chapter-${chapterIndex + 1}`;
    const chapterTitle = `第 ${chapterIndex + 1} 章`;
    const points = [];
    for (let localPointIndex = 0; localPointIndex < 6; localPointIndex += 1) {
      const globalPointIndex = chapterIndex * 6 + localPointIndex;
      const pointId = `point-${String(globalPointIndex + 1).padStart(2, "0")}`;
      const pointTitle = `知识点 ${globalPointIndex + 1}`;
      const sectionCount = globalPointIndex < 6 ? 7 : 6;
      const sectionIds = [];
      const chunkIds = [];

      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        blockPosition += 1;
        const sectionId = `section-${String(blockPosition).padStart(3, "0")}`;
        const chunkId = `chunk-${String(blockPosition).padStart(3, "0")}`;
        const sectionTitle = `${pointTitle} · 单元 ${sectionIndex + 1}`;
        const lineStart = markdownLines.length + 1;
        markdownLines.push(
          `### ${sectionTitle}`,
          `${sectionTitle} 的正文用于验证完整证据覆盖、顺序和摘要哈希。`,
          `这里补充定义、机制、例题与应用边界，保证每个 section 都有真实正文。`,
          "",
        );
        const lineEnd = markdownLines.length;
        const headingPath = [chapterTitle, pointTitle, sectionTitle];
        sectionIds.push(sectionId);
        chunkIds.push(chunkId);
        sections.push({
          id: sectionId,
          order: sections.length,
          type: "section",
          title: sectionTitle,
          heading_level: 3,
          heading_path: headingPath,
          line_start: lineStart,
          line_end: lineEnd,
          page: Math.floor(blockPosition / 2) + 1,
          asset_refs: [],
          sha256: null,
        });
        chunks.push({
          id: chunkId,
          order: chunks.length,
          section_ids: [sectionId],
          heading_path: headingPath,
          line_start: lineStart,
          line_end: lineEnd,
          page: Math.floor(blockPosition / 2) + 1,
          asset_refs: [],
          sha256: null,
        });
      }

      points.push({
        id: pointId,
        title: pointTitle,
        order: localPointIndex,
        origin: "textbook",
        page: chapterIndex * 20 + localPointIndex + 1,
        source_refs: [...sectionIds, ...chunkIds],
      });
      pointSources.push({
        point_id: pointId,
        section_ids: sectionIds,
        chunk_ids: chunkIds,
      });
    }
    sourceChapters.push({
      id: chapterId,
      title: chapterTitle,
      order: chapterIndex,
      points,
    });
  }

  const markdown = markdownLines.join("\n");
  fs.writeFileSync(path.join(documentRoot, "full.md"), markdown, "utf8");
  const normalizedLines = markdown.split("\n");
  for (const block of [...sections, ...chunks]) {
    block.sha256 = sha256(markdownSlice(
      normalizedLines,
      block.line_start,
      block.line_end,
    ));
  }
  assert.equal(sections.length, 78);

  const sourceOutline = {
    schema_version: "textbook-outline/1.0",
    document_id: documentId,
    course: { id: courseId, title: "大规模教材测试" },
    title: "大规模教材测试",
    source: {
      filename: "large.md",
      sha256: "a".repeat(64),
      parser: "markdown-import",
    },
    chapters: sourceChapters,
  };
  const workflowOutline = structuredClone(sourceOutline);
  workflowOutline.chapters[1].points.push({
    id: "point-12-extension",
    title: "知识点 12 的模型扩展",
    order: 6,
    origin: "llm-extension",
    anchor_point_id: "point-12",
    extension_reason: "补充教材知识点的跨情境应用。",
  });
  workflowOutline.chapters[1].points.push({
    id: "point-12-user",
    title: "用户补充的知识点",
    order: 7,
    origin: "user",
    anchor_point_id: "point-12",
  });
  writeJson(path.join(documentRoot, "outline.json"), sourceOutline);
  const outlinePath = path.join(courseRoot, "textbook-outline.json");
  writeJson(outlinePath, workflowOutline);

  writeJson(path.join(documentRoot, "material.json"), {
    schema_version: "textbook-material/1.0",
    document_id: documentId,
    source: {
      format: "markdown",
      filename: "large.md",
      sha256: sourceOutline.source.sha256,
      parser: "markdown-import",
    },
    markdown: {
      path: "full.md",
      sha256: sha256(markdown),
      line_count: normalizedLines.length,
      character_count: [...markdown].length,
    },
    sections,
    chunks,
    point_sources: pointSources,
  });

  writeJson(path.join(root, "textbook-binding.json"), {
    schema_version: "textbook-binding/1.0",
    document_id: documentId,
    course_id: courseId,
    title: sourceOutline.title,
    structure_sha256: textbookStructureSha256(sourceOutline, { courseId }),
    input_outline_path: `textbook-input/${documentId}/outline.json`,
    output_outline_path: `pipeline/${courseId}/textbook-outline.json`,
    input_material_path: `textbook-input/${documentId}/material.json`,
    input_markdown_path: `textbook-input/${documentId}/full.md`,
    chapter_count: 2,
    point_count: 12,
  });

  writeJson(path.join(contentRoot, "src", "data", "course.json"), {
    schema_version: "1.0",
    id: courseId,
    title: sourceOutline.title,
    description: "按照教材原有章节与知识点顺序，讲解定义、机制、例题和应用边界。",
    language: "zh-CN",
    version: "0.1.0",
    updatedAt: "2026-10-22",
  });
  const outlinePoints = workflowOutline.chapters.flatMap((chapter) => chapter.points);
  writeJson(path.join(contentRoot, "src", "data", "index.json"), {
    schema_version: "course-content-index/1.0",
    courseId,
    points: outlinePoints.map((point) => ({
      id: point.id,
      title: point.title,
      shortSummary: `${point.title} 的教材摘要，覆盖定义、机制、例题、应用条件和常见边界。`,
      difficulty: "基础",
      importance: 0.8,
      keyTerms: [point.title, "教材证据"],
    })),
  });
  writeJson(path.join(contentRoot, "generation", "manifest.json"), {});
  return {
    courseId,
    contentRoot,
    manifestPath: path.join(contentRoot, "generation", "manifest.json"),
    outlinePath,
  };
}

function run(script, args, root) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("sync-textbook-manifest deterministically expands anchored non-textbook points", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-manifest-sync-"));
  try {
    const fixture = createLargeFixture(root);
    const first = run(SCRIPT, ["manifest", fixture.courseId], root);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const result = JSON.parse(first.stdout);
    assert.equal(result.sourceSpanCount, 90);

    const firstBytes = fs.readFileSync(fixture.manifestPath, "utf8");
    const manifest = JSON.parse(firstBytes);
    assert.equal(manifest.generation.contentContract, "textbook-content/2.0");
    assert.equal(manifest.generation.evidenceMode, "textbook-grounded");
    assert.equal(manifest.pointEvidence.length, 14);
    assert.deepEqual(
      manifest.pointEvidence[0].sourceSpans.map((span) => span.blockIds[0]),
      Array.from({ length: 7 }, (_, index) => `section-${String(index + 1).padStart(3, "0")}`),
    );
    assert.equal(
      manifest.pointEvidence.slice(0, 12).reduce(
        (count, evidence) => count + evidence.sourceSpans.length,
        0,
      ),
      78,
    );
    for (const evidence of manifest.pointEvidence.slice(-2)) {
      assert.deepEqual(evidence.sourceSpans, manifest.pointEvidence[11].sourceSpans);
      assert.equal(evidence.scopeStatus, "boundary");
    }
    assert.equal(manifest.pointEvidence.at(-2).origin, "llm-extension");
    assert.equal(manifest.pointEvidence.at(-1).origin, "user");
    assert.deepEqual(
      manifest.reviewQueue.map((item) => item.pointId),
      ["point-12-extension", "point-12-user"],
    );
    for (const item of manifest.reviewQueue) {
      assert.equal(
        item.suggestedAction,
        "在 G2 知识点清单审核中确认保留；如需调整或删除，退回 G1 重新生成教材结构。",
      );
    }
    assert.ok(manifest.pointEvidence.every((evidence) => evidence.sourceSpans.length > 0));

    const second = run(SCRIPT, ["manifest", fixture.courseId], root);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), firstBytes);

    manifest.pointEvidence.at(-1).scopeStatus = "core";
    manifest.pointEvidence.at(-1).kind = "method";
    writeJson(fixture.manifestPath, manifest);
    const afterTamper = run(SCRIPT, ["manifest", fixture.courseId], root);
    assert.equal(
      afterTamper.status,
      0,
      `${afterTamper.stdout}\n${afterTamper.stderr}`,
    );
    const resyncedManifest = JSON.parse(
      fs.readFileSync(fixture.manifestPath, "utf8"),
    );
    assert.equal(resyncedManifest.pointEvidence.at(-1).scopeStatus, "boundary");
    assert.equal(resyncedManifest.pointEvidence.at(-1).kind, "concept");
    assert.deepEqual(
      resyncedManifest.reviewQueue.map((item) => item.pointId),
      ["point-12-extension", "point-12-user"],
    );
    assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), firstBytes);

    const contentValidation = run(
      CONTENT_VALIDATOR,
      ["--root", fixture.contentRoot, "--phase", "index"],
      root,
    );
    assert.equal(
      contentValidation.status,
      0,
      `${contentValidation.stdout}\n${contentValidation.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("sync-textbook-manifest rejects an unanchored user point", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-manifest-user-anchor-"));
  try {
    const fixture = createLargeFixture(root);
    const outline = JSON.parse(fs.readFileSync(fixture.outlinePath, "utf8"));
    delete outline.chapters[1].points.at(-1).anchor_point_id;
    writeJson(fixture.outlinePath, outline);

    const result = run(SCRIPT, ["manifest", fixture.courseId], root);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /非教材知识点 point-12-user 必须锚定在同章中已出现的教材知识点/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
