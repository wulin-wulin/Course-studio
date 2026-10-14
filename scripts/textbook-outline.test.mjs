import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = path.resolve("scripts", "validate-textbook-outline.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture(root) {
  const courseId = "textbook-demo";
  const courseRoot = path.join(root, "pipeline", courseId);
  const outline = {
    schema_version: "textbook-outline/1.0",
    document_id: "doc-123",
    course: { id: courseId, title: "教材演示" },
    source: { filename: "demo.pdf", sha256: "a".repeat(64), parser: "local-pdf" },
    chapters: [
      {
        id: "chapter-1",
        title: "第一章",
        order: 0,
        points: [
          { id: "alpha", title: "Alpha", order: 0, origin: "textbook", page: 3 },
          {
            id: "alpha-extension",
            title: "Alpha 扩展",
            order: 1,
            origin: "llm-extension",
            anchor_point_id: "alpha",
            extension_reason: "补充必要应用",
          },
        ],
      },
      {
        id: "chapter-2",
        title: "第二章",
        order: 1,
        points: [
          { id: "beta", title: "Beta", order: 0, origin: "textbook", page: 11 },
        ],
      },
    ],
  };
  const points = outline.chapters.flatMap((chapter) => chapter.points).map((point) => ({
    id: point.id,
    title: point.title,
  }));
  writeJson(path.join(courseRoot, "textbook-outline.json"), outline);
  writeJson(path.join(root, "textbook-input", outline.document_id, "outline.json"), {
    ...structuredClone(outline),
    chapters: outline.chapters.map((chapter) => ({
      ...structuredClone(chapter),
      points: chapter.points
        .filter((point) => point.origin === "textbook")
        .map((point, index) => ({ ...structuredClone(point), order: index })),
    })),
  });
  writeJson(path.join(courseRoot, "course-content", "src", "data", "index.json"), {
    schema_version: "course-content-index/1.0",
    courseId,
    points,
  });
  writeJson(path.join(courseRoot, "clustered-graph.json"), {
    schema_version: "clustered-graph/2.0",
    clusters: outline.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
    points: outline.chapters.flatMap((chapter) => chapter.points.map((point) => ({
      id: point.id,
      clusterIds: [chapter.id],
    }))),
  });
  return { courseId, courseRoot, outline };
}

function run(root, mode, courseId) {
  return spawnSync(process.execPath, [SCRIPT, mode, courseId], {
    cwd: root,
    encoding: "utf8",
  });
}

test("validates the frozen two-level outline and graph mapping", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId } = fixture(root);
    assert.equal(run(root, "outline", courseId).status, 0);
    assert.equal(run(root, "graph", courseId).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an index order that diverges from the textbook tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const indexPath = path.join(courseRoot, "course-content", "src", "data", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.points.reverse();
    writeJson(indexPath, index);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /顺序、ID 或标题不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an index origin that diverges from the textbook tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const indexPath = path.join(courseRoot, "course-content", "src", "data", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.points[0].origin = "llm-extension";
    writeJson(indexPath, index);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /顺序、ID 或标题不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects graph clustering that changes a textbook chapter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const graphPath = path.join(courseRoot, "clustered-graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    graph.points[0].clusterIds = ["chapter-2"];
    writeJson(graphPath, graph);
    const result = run(root, "graph", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /主知识簇不是教材章节/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing an original textbook title while keeping the sidecar valid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].title = "被改写的教材点";
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /ID、顺序、标题或 origin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing an original textbook page locator", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].page = 99;
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /page 已被修改/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing the numeric order of an original textbook point", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].order = 1;
    outline.chapters[0].points[1].order = 2;
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /被移动到其他章节|顺序/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a new point that pretends to be textbook content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[1].points.push({
      id: "invented-textbook-point",
      title: "伪造教材点",
      order: 1,
      origin: "textbook",
    });
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /受控扩展/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a tampered immutable input order even when the workflow sidecar is unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, outline } = fixture(root);
    const inputPath = path.join(root, "textbook-input", outline.document_id, "outline.json");
    const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    input.chapters[0].points[0].order = 9;
    writeJson(inputPath, input);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材输入知识点 .*order/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked textbook input parent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, outline } = fixture(root);
    const inputRoot = path.join(root, "textbook-input");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-input-outside-"));
    const outsideDocumentRoot = path.join(outside, outline.document_id);
    fs.mkdirSync(outsideDocumentRoot, { recursive: true });
    fs.copyFileSync(
      path.join(inputRoot, outline.document_id, "outline.json"),
      path.join(outsideDocumentRoot, "outline.json"),
    );
    fs.rmSync(inputRoot, { recursive: true, force: true });
    try {
      // Junctions are available on Windows without requiring Developer Mode;
      // on platforms without symlink support this regression is skipped.
      fs.symlinkSync(outside, inputRoot, "junction");
    } catch (error) {
      t.skip(`symbolic links unavailable: ${error.message}`);
      return;
    }
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不允许符号链接/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
