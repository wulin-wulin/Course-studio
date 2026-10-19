import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAnimationRegistry } from '../skills/candidate-knowledge-point-generator/scripts/build_animation_registry.mjs';
import { createCourseFixture } from '../skills/candidate-knowledge-point-generator/scripts/test-fixture.mjs';
import { textbookStructureSha256 } from '../skills/knowledge-pipeline-orchestrator/scripts/textbook-structure.mjs';
import { reviewHashes } from './prepare-course-review.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREPARE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'prepare-course-review.mjs');
const INIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'init-course-pipeline.mjs');
const CHECKER_SCRIPT = path.join(
  PROJECT_ROOT,
  'skills',
  'knowledge-pipeline-orchestrator',
  'scripts',
  'check-pipeline.mjs',
);
const COURSE_ID = 'state-machines';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
  }
}

function makeWorkspace(t, { full = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'textbook-review-hash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createCourseFixture(t, { withAnimation: false, includeDetails: full });
  if (full) buildAnimationRegistry(fixture.root);
  const contentRoot = path.join(root, 'pipeline', COURSE_ID, 'course-content');
  copyDirectory(fixture.root, contentRoot);
  return { root, contentRoot, courseRoot: path.dirname(contentRoot) };
}

function validOutline() {
  return {
    schema_version: 'textbook-outline/1.0',
    document_id: 'document-1',
    course: { id: COURSE_ID, title: '教材课程' },
    source: { filename: 'book.pdf', sha256: 'a'.repeat(64), parser: 'local-pdf' },
    chapters: [
      {
        id: 'chapter-one',
        title: '第一章',
        order: 0,
        points: [
          { id: 'input-state', title: '输入状态', order: 0, origin: 'textbook' },
          { id: 'state-transition', title: '状态转移', order: 1, origin: 'textbook' },
        ],
      },
      {
        id: 'chapter-two',
        title: '第二章',
        order: 1,
        points: [
          { id: 'terminal-condition', title: '终止条件', order: 0, origin: 'textbook' },
        ],
      },
    ],
  };
}

function makeGraph(courseRoot) {
  const index = readJson(path.join(courseRoot, 'course-content', 'src', 'data', 'index.json'));
  const manifest = readJson(path.join(courseRoot, 'course-content', 'generation', 'manifest.json'));
  const points = index.points.map((point, pointIndex) => ({
    ...readJson(path.join(
      courseRoot,
      'course-content',
      'src',
      'data',
      'points',
      `${point.id}.json`,
    )),
    prerequisites: pointIndex === 0 ? [] : [index.points[pointIndex - 1].id],
    clusterIds: [pointIndex < 2 ? 'chapter-one' : 'chapter-two'],
    role: pointIndex === 0 || pointIndex === 2 ? 'trunk' : 'branch',
    related: [],
  }));
  return {
    schema_version: 'clustered-graph/2.0',
    subject: manifest.subject,
    generation: {
      generatedAt: '2026-10-14',
      sourceCourseId: COURSE_ID,
      pointCount: points.length,
      clusterCount: 2,
      refinedPrerequisiteEdges: [],
      brokenCycleEdges: [],
    },
    clusters: [
      {
        id: 'chapter-one',
        title: '第一章',
        subtitle: '状态过程',
        description: '描述状态如何发生变化。',
        order: 0,
      },
      {
        id: 'chapter-two',
        title: '第二章',
        subtitle: '终止结果',
        description: '描述过程如何结束。',
        order: 1,
      },
    ],
    points,
  };
}

function approvalBase(kind) {
  return {
    schema_version: 'course-review-approval/1.0',
    review_id: `review-${kind}`,
    course_id: COURSE_ID,
    kind,
    gate: kind === 'knowledge-points' ? 'G2_IDENTITY_REVIEW' : 'G6_GRAPH_REVIEW',
    approved_at: '2026-10-14T00:00:00.000Z',
    operation_count: 0,
    submitted_operations: [],
  };
}

function writeApproval(root, kind, outline, points, graph = null) {
  const hashes = reviewHashes(
    kind,
    points,
    graph,
    textbookStructureSha256(outline, { courseId: COURSE_ID }),
  );
  writeJson(path.join(root, '.course-review-approvals', COURSE_ID, `${kind}.json`), {
    ...approvalBase(kind),
    identity_sha256: hashes.identitySha256,
    textbook_structure_sha256: hashes.textbookStructureSha256,
    ...(kind === 'knowledge-graph' ? {
      clusters_sha256: hashes.clustersSha256,
      prerequisites_sha256: hashes.prerequisitesSha256,
      review_audit_sha256: hashes.reviewAuditSha256,
    } : {}),
  });
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('绑定教材在 G2 审核通过后可以初始化详情任务', (t) => {
  const { root, contentRoot, courseRoot } = makeWorkspace(t);
  const outline = validOutline();
  writeJson(path.join(courseRoot, 'textbook-outline.json'), outline);
  writeJson(path.join(root, 'textbook-input', outline.document_id, 'outline.json'), outline);
  writeJson(path.join(root, 'textbook-binding.json'), {
    document_id: outline.document_id,
    course_id: COURSE_ID,
    output_outline_path: `pipeline/${COURSE_ID}/textbook-outline.json`,
    structure_sha256: textbookStructureSha256(outline, { courseId: COURSE_ID }),
  });
  const index = readJson(path.join(contentRoot, 'src', 'data', 'index.json'));
  writeApproval(root, 'knowledge-points', outline, index.points);
  const initialized = run(INIT_SCRIPT, [COURSE_ID, '--stage', 'points'], root);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).created.length, index.points.length * 2);
  for (const point of index.points) {
    assert.deepEqual(readJson(path.join(contentRoot, 'src/data/points', `${point.id}.json`)), {});
    assert.deepEqual(readJson(path.join(contentRoot, 'generation/animation-requests', `${point.id}.json`)), {});
  }
});

test('教材章节归属变化会让 prepare、init 和最终 checker 拒绝旧回执', (t) => {
  const { root, contentRoot, courseRoot } = makeWorkspace(t, { full: true });
  const outline = validOutline();
  const outlinePath = path.join(courseRoot, 'textbook-outline.json');
  writeJson(outlinePath, outline);

  const index = readJson(path.join(contentRoot, 'src', 'data', 'index.json'));
  const graph = makeGraph(courseRoot);
  writeJson(path.join(courseRoot, 'clustered-graph.json'), graph);
  writeApproval(root, 'knowledge-points', outline, index.points);
  writeApproval(root, 'knowledge-graph', outline, graph.points, graph);

  const approved = run(PREPARE_SCRIPT, ['knowledge-points', COURSE_ID], root);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).status, 'approved');
  const checked = run(
    CHECKER_SCRIPT,
    [
      contentRoot,
      path.join(courseRoot, 'clustered-graph.json'),
      '--phase',
      'all',
      '--json',
    ],
    root,
  );
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).counts.reviewApprovals, 2);

  // Keep the flattened index unchanged while moving one point to another
  // chapter.  This is precisely the stale-sidecar case that identity hashes
  // alone cannot detect.
  const changed = structuredClone(outline);
  changed.chapters[0].points = [changed.chapters[0].points[0]];
  changed.chapters[1].points = [
    structuredClone(outline.chapters[0].points[1]),
    changed.chapters[1].points[0],
  ];
  changed.chapters[1].points[0].order = 0;
  changed.chapters[1].points[1].order = 1;
  writeJson(outlinePath, changed);

  const pending = run(PREPARE_SCRIPT, ['knowledge-points', COURSE_ID], root);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, 'pending');

  const blocked = run(INIT_SCRIPT, [COURSE_ID, '--stage', 'points'], root);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /教材章节变化而失效/);

  const stale = run(
    CHECKER_SCRIPT,
    [
      contentRoot,
      path.join(courseRoot, 'clustered-graph.json'),
      '--phase',
      'all',
      '--json',
    ],
    root,
  );
  assert.notEqual(stale.status, 0);
  const report = JSON.parse(stale.stdout);
  assert.ok(report.findings.some((finding) => finding.code === 'invalid-knowledge-points-approval'));
  assert.ok(report.findings.some((finding) => finding.code === 'invalid-knowledge-graph-approval'));

  // Once the graph is updated to the new chapter assignment, G6 still cannot
  // reuse its old approval.  The G2 receipt is refreshed here so this check
  // isolates the graph receipt's structural hash.
  const remappedGraph = structuredClone(graph);
  remappedGraph.points[1].clusterIds = ['chapter-two'];
  writeJson(path.join(courseRoot, 'clustered-graph.json'), remappedGraph);
  writeApproval(root, 'knowledge-points', changed, index.points);
  const graphPending = run(PREPARE_SCRIPT, ['knowledge-graph', COURSE_ID], root);
  assert.equal(graphPending.status, 0, graphPending.stderr);
  assert.equal(JSON.parse(graphPending.stdout).status, 'pending');
});
