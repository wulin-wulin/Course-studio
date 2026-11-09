import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("catalog drafts are only cleared after a successful mutation", async () => {
  const source = await readFile(
    path.join(frontendRoot, "src/components/course/CourseCatalog.tsx"),
    "utf8",
  );

  assert.match(source, /await loadCourses\(\);\s*return true;/);
  assert.match(source, /setCatalogError\([\s\S]*?\);\s*return false;/);
  assert.match(
    source,
    /const succeeded = await mutateCatalog\(`\$\{CATALOG_API\}\/groups`,[\s\S]*?if \(succeeded\) setNewGroupName\(""\);/,
  );
  assert.match(
    source,
    /const succeeded = await mutateCatalog\(`\$\{CATALOG_API\}\/groups\/\$\{encodeURIComponent\(groupId\)\}`,\s*\{[\s\S]*?if \(succeeded\) setEditingGroupId\(null\);/,
  );
});

test("agent panel exposes the curriculum-guided creation mode", async () => {
  const source = await readFile(
    path.join(frontendRoot, "src/components/chat/AgentPanel.tsx"),
    "utf8",
  );

  assert.match(source, /"textbook-curriculum"/);
  assert.match(source, /curriculum_document_id: curriculumDocumentId/);
  assert.match(source, /source_mode: sourceMode/);
  assert.match(source, /<CurriculumCourseCreationForm/);
  assert.match(source, /教材 \+ 大纲/);
});

test("the case diagram is a non-interactive canvas layer beneath graph edges and nodes", async () => {
  const [graphSource, pageSource, cssSource] = await Promise.all([
    readFile(path.join(frontendRoot, "src/components/course/CourseGroupGraph.tsx"), "utf8"),
    readFile(path.join(frontendRoot, "src/components/course/CourseGroupPage.tsx"), "utf8"),
    readFile(path.join(frontendRoot, "src/components/course/CourseGroupPage.css"), "utf8"),
  ]);

  assert.match(pageSource, /<CourseGroupGraph groupId=\{group\.id\}/);
  assert.match(graphSource, /viewBox=\{`0 0 \$\{graphBounds\.width\} \$\{graphBounds\.height\}`\}/);
  assert.match(graphSource, /data-canvas-image=\{element\.id\}[\s\S]*?pointerEvents="none"[\s\S]*?<image/);
  assert.match(graphSource, /<desc>\{element\.description\}<\/desc>/);
  assert.match(cssSource, /\.course-map__canvas-image\s*\{\s*pointer-events:\s*none;/);

  const imageLayer = graphSource.indexOf("{canvasElements.map((element)");
  const edgeLayer = graphSource.indexOf("{edges.map((edge)");
  const nodeLayer = graphSource.indexOf("{courses.map((course, index)");
  assert.ok(imageLayer >= 0 && edgeLayer > imageLayer && nodeLayer > edgeLayer);
});
