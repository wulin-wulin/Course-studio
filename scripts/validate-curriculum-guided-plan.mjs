#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXTBOOK_ID = /^doc-[0-9a-f]{24}(?:-[0-9a-f]{8})?$/;
const CURRICULUM_ID = /^curr-[0-9a-f]{24}$/;
const ACTIONS = new Set(["retain", "rename", "merge", "split", "add"]);
const COVERAGE = new Set(["covered", "partial", "gap"]);
const PLAN_SCHEMA = "curriculum-guided-plan/1.0";
const BINDING_SCHEMA = "curriculum-guided-binding/1.0";

function fail(message) { throw new Error(message); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}
function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`拒绝访问课程工作区之外的路径：${target}`);
  }
}
function readJson(root, target, label) {
  ensureInside(root, target);
  if (!fs.existsSync(target)) fail(`缺少${label}：${path.relative(root, target)}`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件`);
  try { return JSON.parse(fs.readFileSync(target, "utf8")); }
  catch (error) { fail(`${label}不是有效 JSON：${error.message}`); }
}
function strings(value, label, { allowed = null, nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) fail(`${label}必须是${nonEmpty ? "非空" : ""}数组`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item || seen.has(item) || (allowed && !allowed.has(item))) {
      fail(`${label}包含空值、重复值或悬空引用`);
    }
    seen.add(item);
  }
  return value;
}
function flattenOutline(outline) {
  if (!Array.isArray(outline?.chapters)) fail("教材结构缺少 chapters");
  const points = [];
  for (const chapter of outline.chapters) {
    if (!record(chapter) || !Array.isArray(chapter.points)) fail("教材章节格式无效");
    for (const point of chapter.points) {
      if (!record(point) || !ID.test(point.id ?? "") || typeof point.title !== "string" || !point.title.trim()) {
        fail("教材结构包含无效知识点");
      }
      points.push(point);
    }
  }
  return points;
}
function sourceContext(material) {
  if (!Array.isArray(material?.sections) || !Array.isArray(material?.point_sources)) {
    fail("教材材料索引缺少 sections 或 point_sources");
  }
  const sections = new Map(material.sections.map((item) => [item.id, item]));
  const byPoint = new Map();
  for (const item of material.point_sources) {
    if (!record(item) || typeof item.point_id !== "string") fail("material.point_sources 格式无效");
    byPoint.set(item.point_id, strings(item.section_ids, `教材点 ${item.point_id} 的 section_ids`, { allowed: new Set(sections.keys()), nonEmpty: true }));
  }
  return { sections, byPoint };
}
function spanFor(section, documentId) {
  if (!record(section) || !ID.test(section.id ?? "") || !Number.isInteger(section.line_start) || !Number.isInteger(section.line_end)) {
    fail(`教材 section ${section?.id ?? "<unknown>"} 缺少有效行号`);
  }
  const span = {
    materialId: documentId,
    blockIds: [section.id],
    headingPath: Array.isArray(section.heading_path) ? [...section.heading_path] : [],
    lineStart: section.line_start,
    lineEnd: section.line_end,
    assetRefs: Array.isArray(section.asset_refs) ? [...section.asset_refs] : [],
    excerptSha256: String(section.sha256 ?? ""),
  };
  if (Number.isInteger(section.page) && section.page > 0) span.page = section.page;
  return span;
}

export function curriculumGuidanceSha256(binding, requirementsFileSha256, planFileSha256, points) {
  return sha256Json({
    binding: {
      schema_version: binding.schema_version,
      textbook_document_id: binding.textbook_document_id,
      curriculum_document_id: binding.curriculum_document_id,
      course_id: binding.course_id,
      textbook_sha256: binding.textbook_sha256,
      curriculum_sha256: binding.curriculum_sha256,
      guidance_sha256: binding.guidance_sha256,
    },
    requirements_file_sha256: requirementsFileSha256,
    plan_file_sha256: planFileSha256,
    identity: points.map((point) => [point.id, point.title.trim()]),
  });
}

export function loadAndValidateCurriculumGuidance(root, courseId, { syncManifest = false } = {}) {
  const binding = readJson(root, path.join(root, "curriculum-guided-binding.json"), "培养方案辅助绑定");
  if (
    binding.schema_version !== BINDING_SCHEMA
    || binding.course_id !== courseId
    || !TEXTBOOK_ID.test(binding.textbook_document_id ?? "")
    || !CURRICULUM_ID.test(binding.curriculum_document_id ?? "")
  ) fail("培养方案辅助绑定与课程不一致");
  const expectedPlan = `pipeline/${courseId}/curriculum-guided-plan.json`;
  if (binding.output_plan_path !== expectedPlan) fail("培养方案调整计划路径与绑定不一致");
  const input = (field, label) => readJson(root, path.join(root, ...String(binding[field] ?? "").split("/")), label);
  const outline = input("textbook_outline_path", "教材输入结构");
  const material = input("textbook_material_path", "教材材料索引");
  const requirementsPath = path.join(
    root,
    ...String(binding.curriculum_requirements_path ?? "").split("/"),
  );
  const requirements = readJson(root, requirementsPath, "培养方案要求");
  if (outline.document_id !== binding.textbook_document_id || requirements.document_id !== binding.curriculum_document_id) {
    fail("双源输入 document_id 与绑定不一致");
  }
  const sourcePoints = flattenOutline(outline);
  const sourcePointIds = new Set(sourcePoints.map((point) => point.id));
  const requirementIds = new Set((requirements.requirements ?? []).map((item) => item?.id).filter(Boolean));
  const source = sourceContext(material);
  const courseRoot = path.join(root, "pipeline", courseId);
  const planPath = path.join(courseRoot, "curriculum-guided-plan.json");
  const plan = readJson(root, planPath, "培养方案调整计划");
  const index = readJson(root, path.join(courseRoot, "course-content", "src", "data", "index.json"), "课程索引");
  if (plan.schema_version !== PLAN_SCHEMA || plan.course?.id !== courseId) fail(`调整计划必须使用 ${PLAN_SCHEMA} 且 course.id 正确`);
  if (
    plan.sources?.textbook_document_id !== binding.textbook_document_id
    || plan.sources?.curriculum_document_id !== binding.curriculum_document_id
  ) fail("调整计划的双源 ID 与绑定不一致");
  if (!Array.isArray(plan.points) || plan.points.length === 0 || !Array.isArray(plan.clusters) || plan.clusters.length === 0) {
    fail("调整计划必须包含非空 points 和 clusters");
  }
  if (index.schema_version !== "course-content-index/1.0" || index.courseId !== courseId || !Array.isArray(index.points)) {
    fail("课程索引格式或 courseId 无效");
  }
  const finalIds = new Set();
  const referencedSourcePointIds = new Set();
  const normalizedPoints = plan.points.map((point, position) => {
    const label = `plan.points[${position}]`;
    if (!record(point) || !ID.test(point.id ?? "") || finalIds.has(point.id) || typeof point.title !== "string" || !point.title.trim()) fail(`${label} 的 id/title 无效或重复`);
    if (point.order !== position) fail(`${label}.order 必须连续且与数组顺序一致`);
    if (!ACTIONS.has(point.action)) fail(`${label}.action 无效`);
    if (!COVERAGE.has(point.coverage)) fail(`${label}.coverage 无效`);
    strings(point.sourcePointIds, `${label}.sourcePointIds`, { allowed: sourcePointIds });
    point.sourcePointIds.forEach((id) => referencedSourcePointIds.add(id));
    strings(point.sourceRefs, `${label}.sourceRefs`, { allowed: new Set(source.sections.keys()) });
    strings(point.requirementRefs, `${label}.requirementRefs`, { allowed: requirementIds });
    strings(point.clusterIds, `${label}.clusterIds`, { nonEmpty: true });
    if (typeof point.changeReason !== "string" || !point.changeReason.trim()) fail(`${label}.changeReason 不能为空`);
    const evidenceSections = new Set(point.sourceRefs);
    for (const sourcePointId of point.sourcePointIds) {
      for (const sectionId of source.byPoint.get(sourcePointId) ?? []) evidenceSections.add(sectionId);
    }
    if (point.coverage !== "gap" && evidenceSections.size === 0) fail(`${label} 的 covered/partial 必须引用教材证据`);
    if (
      point.coverage === "gap"
      && (
        evidenceSections.size > 0
        || (
          point.requirementRefs.length === 0
          && point.reviewAdjustment !== "user-add"
        )
      )
    ) {
      fail(`${label} 的 gap 不得伪装教材证据，且必须引用培养要求`);
    }
    if (point.action === "retain" && point.sourcePointIds.length !== 1) fail(`${label} 的 retain 必须对应一个教材点`);
    if (["rename", "merge", "split"].includes(point.action) && point.sourcePointIds.length === 0) fail(`${label} 的 ${point.action} 必须引用教材点`);
    finalIds.add(point.id);
    return { point, evidenceSections };
  });
  const omittedSourcePoints = [...sourcePointIds].filter((id) => !referencedSourcePointIds.has(id));
  const declaredOmissions = Array.isArray(plan.omittedSourcePoints)
    ? plan.omittedSourcePoints
    : [];
  const declaredOmissionIds = new Set();
  for (const [position, omission] of declaredOmissions.entries()) {
    if (
      !record(omission)
      || !sourcePointIds.has(omission.sourcePointId)
      || declaredOmissionIds.has(omission.sourcePointId)
      || typeof omission.reason !== "string"
      || !omission.reason.trim()
    ) fail(`plan.omittedSourcePoints[${position}] 无效`);
    declaredOmissionIds.add(omission.sourcePointId);
  }
  if (
    omittedSourcePoints.some((id) => !declaredOmissionIds.has(id))
    || [...declaredOmissionIds].some((id) => referencedSourcePointIds.has(id))
  ) {
    fail("未映射的教材知识点必须在 omittedSourcePoints 中逐项说明，且不能同时被最终点引用");
  }
  const clusterIds = new Set();
  const clusteredPoints = new Set();
  const clustersByPoint = new Map([...finalIds].map((id) => [id, new Set()]));
  for (const [position, cluster] of plan.clusters.entries()) {
    if (!record(cluster) || !ID.test(cluster.id ?? "") || clusterIds.has(cluster.id) || typeof cluster.title !== "string" || !cluster.title.trim() || cluster.order !== position) fail(`plan.clusters[${position}] 无效`);
    clusterIds.add(cluster.id);
    strings(cluster.pointIds, `plan.clusters[${position}].pointIds`, { allowed: finalIds, nonEmpty: true }).forEach((id) => {
      clusteredPoints.add(id);
      clustersByPoint.get(id).add(cluster.id);
    });
    strings(cluster.requirementRefs ?? [], `plan.clusters[${position}].requirementRefs`, { allowed: requirementIds });
    if (typeof cluster.reason !== "string" || !cluster.reason.trim()) fail(`plan.clusters[${position}].reason 不能为空`);
  }
  if (clusteredPoints.size !== finalIds.size) fail("每个最终知识点都必须归入至少一个知识簇");
  for (const { point } of normalizedPoints) {
    if (point.clusterIds.some((id) => !clusterIds.has(id))) fail(`知识点 ${point.id} 引用了不存在的知识簇`);
    if (JSON.stringify([...clustersByPoint.get(point.id)]) !== JSON.stringify(point.clusterIds)) {
      fail(`知识点 ${point.id} 的 clusterIds 必须与 clusters[].pointIds 双向一致且同序`);
    }
  }
  if (index.points.length !== plan.points.length) fail("index.points 必须与调整计划等长");
  index.points.forEach((point, position) => {
    const planned = plan.points[position];
    if (point?.id !== planned.id || point?.title?.trim() !== planned.title.trim()) fail("index.points 必须与调整计划的 ID、标题和顺序完全一致");
  });

  if (syncManifest) {
    const course = readJson(root, path.join(courseRoot, "course-content", "src", "data", "course.json"), "课程元数据");
    if (course.id !== courseId || typeof course.title !== "string" || !course.title.trim() || typeof course.description !== "string" || !course.description.trim()) fail("生成 manifest 前必须完成课程元数据");
    const generatedAt = typeof course.updatedAt === "string" ? course.updatedAt : new Date().toISOString().slice(0, 10);
    const textbookSourceId = "src-textbook";
    const curriculumSourceId = "src-curriculum";
    const hasUserReviewAdditions = normalizedPoints.some(
      ({ point }) => point.reviewAdjustment === "user-add",
    );
    if (hasUserReviewAdditions) {
      fail("G2 审核写回后不得重新同步 manifest；请保留审核签名后的知识点清单");
    }
    const pointEvidence = normalizedPoints.map(({ point, evidenceSections }) => ({
      pointId: point.id,
      title: point.title.trim(),
      kind: "concept",
      sourceRefs: [
        ...(evidenceSections.size > 0 ? [textbookSourceId] : []),
        ...(point.requirementRefs.length > 0 ? [curriculumSourceId] : []),
        ...(point.reviewAdjustment === "user-add" ? ["src-user-review"] : []),
      ],
      confidence: point.coverage === "covered" ? 0.95 : point.coverage === "partial" ? 0.75 : 0.45,
      scopeStatus: point.coverage === "covered" ? "core" : point.coverage === "partial" ? "boundary" : "needs-review",
      origin: point.reviewAdjustment === "user-add"
        ? "user"
        : point.action === "retain" ? "textbook" : "llm-extension",
      coverage: point.coverage,
      sourceSpans: [...evidenceSections].map((id) => spanFor(source.sections.get(id), binding.textbook_document_id)),
    }));
    const reviewQueue = pointEvidence.filter((item, position) => item.scopeStatus !== "core" || plan.points[position].action !== "retain").map((item, position) => ({
      pointId: item.pointId,
      term: item.title,
      issue: item.coverage === "gap" ? "insufficient-evidence" : "scope-ambiguity",
      reason: plan.points.find((point) => point.id === item.pointId)?.changeReason ?? "培养方案触发知识点调整",
      suggestedAction: "在 G2 知识点清单审核中确认、删除或补充该知识点。",
    }));
    const manifest = {
      schema_version: "course-content-generation/1.0",
      subject: {
        id: courseId,
        input: outline.course?.title ?? course.title,
        normalizedTitle: course.title.trim(),
        inputType: "course",
        language: course.language || "zh-CN",
        audience: "培养方案对应专业学习者",
        depth: "结合教材深度并满足培养方案知识要求",
        scope: course.description.trim(),
        exclusions: [],
        outcomes: (requirements.course_goals ?? []).map((goal) => typeof goal === "string" ? goal : goal?.text).filter(Boolean).slice(0, 12),
      },
      generation: {
        evidenceMode: "textbook-grounded",
        guidanceMode: "curriculum-guided",
        generatedAt,
        pointCount: plan.points.length,
        contentContract: "textbook-content/2.0",
      },
      sources: [
        { id: textbookSourceId, type: "textbook", title: outline.source?.filename || course.title, locator: binding.textbook_markdown_path, accessedAt: generatedAt },
        { id: curriculumSourceId, type: "curriculum", title: requirements.title || "培养方案/教学大纲", locator: binding.curriculum_markdown_path, accessedAt: generatedAt },
        ...(hasUserReviewAdditions ? [{ id: "src-user-review", type: "reference", title: "课程知识点结构化用户审核", locator: "course-studio://reviews/g2", accessedAt: generatedAt }] : []),
      ],
      pointEvidence,
      reviewQueue,
    };
    if (manifest.subject.outcomes.length === 0) manifest.subject.outcomes = [`掌握并运用${course.title.trim()}的核心知识。`];
    const manifestPath = path.join(courseRoot, "course-content", "generation", "manifest.json");
    ensureInside(root, manifestPath);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } else {
    const manifest = readJson(
      root,
      path.join(courseRoot, "course-content", "generation", "manifest.json"),
      "课程生成 manifest",
    );
    if (
      manifest.generation?.evidenceMode !== "textbook-grounded"
      || manifest.generation?.guidanceMode !== "curriculum-guided"
      || manifest.generation?.contentContract !== "textbook-content/2.0"
      || manifest.generation?.pointCount !== plan.points.length
      || !Array.isArray(manifest.pointEvidence)
      || manifest.pointEvidence.length !== plan.points.length
    ) fail("manifest 未声明有效的培养方案辅助教材契约");
    for (const [position, { point, evidenceSections }] of normalizedPoints.entries()) {
      const evidence = manifest.pointEvidence[position];
      const expectedSpans = [...evidenceSections].map((id) => spanFor(source.sections.get(id), binding.textbook_document_id));
      if (
        evidence?.pointId !== point.id
        || evidence?.title?.trim() !== point.title.trim()
        || evidence?.coverage !== point.coverage
        || JSON.stringify(evidence?.sourceSpans) !== JSON.stringify(expectedSpans)
      ) fail(`manifest.pointEvidence[${position}] 与培养方案调整计划或教材证据不一致`);
    }
  }
  return {
    binding,
    requirements,
    plan,
    points: index.points,
    curriculumGuidanceSha256: curriculumGuidanceSha256(
      binding,
      crypto.createHash("sha256").update(fs.readFileSync(requirementsPath)).digest("hex"),
      crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex"),
      index.points,
    ),
  };
}

function main() {
  const [mode, courseId, ...extra] = process.argv.slice(2);
  if (!["plan", "manifest"].includes(mode) || !ID.test(courseId ?? "") || extra.length > 0) {
    fail("用法：node validate-curriculum-guided-plan.mjs plan|manifest <course-id>");
  }
  const result = loadAndValidateCurriculumGuidance(path.resolve(process.cwd()), courseId, { syncManifest: mode === "manifest" });
  process.stdout.write(`${JSON.stringify({ courseId, mode, pointCount: result.points.length, curriculumGuidanceSha256: result.curriculumGuidanceSha256, status: "valid" })}\n`);
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  try { main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
