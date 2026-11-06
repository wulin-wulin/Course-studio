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
