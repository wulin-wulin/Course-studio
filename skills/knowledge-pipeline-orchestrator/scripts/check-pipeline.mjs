#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SOURCE_ID = /^src-[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONTENT_FIELDS = ["id", "title", "aliases", "kind", "shortSummary", "difficulty", "importance", "keyTerms"]
const ALLOWED_KINDS = new Set(["concept", "method", "theorem", "model", "algorithm", "task", "metric", "phenomenon"])
const ALLOWED_DIFFICULTIES = new Set(["基础", "中等", "进阶"])
const ALLOWED_SCOPE = new Set(["core", "boundary", "needs-review"])
const ALLOWED_ROLES = new Set(["trunk", "branch", "leaf"])
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAG_SCRIPT = path.resolve(HERE, "../../knowledge-cluster-builder/scripts/check-dag.mjs")

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function load(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`无法读取或解析 ${file}: ${error.message}`)
  }
}

function add(findings, severity, stage, code, message, detail = {}) {
  findings.push({ severity, stage, code, message, ...detail })
}

function checkSorted(items, field, findings, stage, code) {
  const values = items.map((item) => item?.[field])
  const sorted = [...values].sort((a, b) => String(a).localeCompare(String(b), "en"))
  if (!equal(values, sorted)) add(findings, "error", stage, code, `${field} 未按确定性顺序排列`)
}

function validateCandidate(data) {
  const findings = []
  if (data?.schema_version !== "candidate-points/1.0") {
    add(findings, "error", "candidate", "bad-schema-version", "schema_version 必须为 candidate-points/1.0")
  }
  if (!data?.subject || typeof data.subject !== "object") add(findings, "error", "candidate", "missing-subject", "subject 缺失")
  if (!data?.generation || typeof data.generation !== "object") {
    add(findings, "error", "candidate", "missing-generation", "generation 缺失")
  }
  if (!Array.isArray(data?.sources)) add(findings, "error", "candidate", "sources-not-array", "sources 必须是数组")
  if (!Array.isArray(data?.candidates)) add(findings, "error", "candidate", "candidates-not-array", "candidates 必须是数组")
  if (!Array.isArray(data?.reviewQueue)) add(findings, "error", "candidate", "review-not-array", "reviewQueue 必须是数组")
  if (findings.some((item) => item.severity === "error")) return { findings, ids: new Set(), byId: new Map() }

  const sources = data.sources
  const candidates = data.candidates
  const sourceIds = new Set()
  for (const [index, source] of sources.entries()) {
    if (!SOURCE_ID.test(source?.id ?? "")) add(findings, "error", "candidate", "bad-source-id", `sources[${index}].id 非法`, { value: source?.id })
    if (sourceIds.has(source?.id)) add(findings, "error", "candidate", "duplicate-source-id", `来源 id 重复: ${source?.id}`)
    sourceIds.add(source?.id)
  }
  checkSorted(sources, "id", findings, "candidate", "sources-not-sorted")
  checkSorted(candidates, "id", findings, "candidate", "candidates-not-sorted")
  checkSorted(data.reviewQueue, "term", findings, "candidate", "review-not-sorted")

  const ids = new Set()
  const byId = new Map()
  for (const [index, point] of candidates.entries()) {
    const id = point?.id
    if (!KEBAB.test(id ?? "")) add(findings, "error", "candidate", "bad-point-id", `candidates[${index}].id 非 kebab-case`, { value: id })
    if (ids.has(id)) add(findings, "error", "candidate", "duplicate-point-id", `候选点 id 重复: ${id}`)
    ids.add(id)
    byId.set(id, point)
    if (!ALLOWED_KINDS.has(point?.kind)) add(findings, "error", "candidate", "bad-kind", `${id}.kind 非法`, { value: point?.kind })
    if (!ALLOWED_DIFFICULTIES.has(point?.difficulty)) add(findings, "error", "candidate", "bad-difficulty", `${id}.difficulty 非法`)
    if (!ALLOWED_SCOPE.has(point?.scopeStatus)) add(findings, "error", "candidate", "bad-scope-status", `${id}.scopeStatus 非法`)
    if (typeof point?.shortSummary !== "string" || point.shortSummary.length < 30 || point.shortSummary.length > 100) {
      add(findings, "error", "candidate", "bad-summary-length", `${id}.shortSummary 长度必须为 30–100`)
    }
    if (!Number.isFinite(point?.importance) || point.importance < 0 || point.importance > 1) add(findings, "error", "candidate", "bad-importance", `${id}.importance 必须在 0–1`)
    if (!Number.isFinite(point?.confidence) || point.confidence < 0 || point.confidence > 1) add(findings, "error", "candidate", "bad-confidence", `${id}.confidence 必须在 0–1`)
    if (!Array.isArray(point?.aliases)) add(findings, "error", "candidate", "aliases-not-array", `${id}.aliases 必须是数组`)
    if (!Array.isArray(point?.keyTerms) || point.keyTerms.length < 2 || point.keyTerms.length > 8) add(findings, "error", "candidate", "bad-key-terms", `${id}.keyTerms 必须有 2–8 项`)
    if (!Array.isArray(point?.sourceRefs)) {
      add(findings, "error", "candidate", "source-refs-not-array", `${id}.sourceRefs 必须是数组`)
    } else {
      for (const ref of point.sourceRefs) if (!sourceIds.has(ref)) add(findings, "error", "candidate", "dangling-source-ref", `${id}.sourceRefs 引用不存在的 ${ref}`)
    }
  }

  if (data.generation.candidateCount !== candidates.length) {
    add(findings, "error", "candidate", "candidate-count-mismatch", `candidateCount=${data.generation.candidateCount}，实际=${candidates.length}`)
  }
  const mode = data.generation.evidenceMode
  if (mode === "researched") {
    if (sources.length < 3) add(findings, "error", "candidate", "too-few-sources", "researched 模式至少需要 3 个来源")
    if (new Set(sources.map((source) => source.type)).size < 2) add(findings, "error", "candidate", "too-few-source-types", "researched 模式至少需要 2 种来源类型")
    for (const point of candidates) if (!point.sourceRefs?.length) add(findings, "error", "candidate", "missing-source-ref", `${point.id} 在 researched 模式缺少来源`)
  } else if (mode === "model-only") {
    if (sources.length) add(findings, "error", "candidate", "model-only-has-sources", "model-only 模式 sources 必须为空")
    for (const point of candidates) {
      if (point.sourceRefs?.length) add(findings, "error", "candidate", "model-only-has-source-ref", `${point.id} 在 model-only 模式不得有 sourceRefs`)
      if (point.confidence > 0.6) add(findings, "error", "candidate", "model-only-confidence", `${point.id}.confidence 不得高于 0.6`)
    }
  } else {
    add(findings, "error", "candidate", "bad-evidence-mode", `evidenceMode 非法: ${mode}`)
  }
  return { findings, ids, byId }
}

function validateGraph(candidate, graph, graphFile) {
  const findings = []
  if (graph?.schema_version !== "clustered-graph/1.0") add(findings, "error", "graph", "bad-schema-version", "schema_version 必须为 clustered-graph/1.0")
  if (!Array.isArray(graph?.clusters)) add(findings, "error", "graph", "clusters-not-array", "clusters 必须是数组")
  if (!Array.isArray(graph?.points)) add(findings, "error", "graph", "points-not-array", "points 必须是数组")
  if (!graph?.generation || typeof graph.generation !== "object") add(findings, "error", "graph", "missing-generation", "generation 缺失")
  if (findings.some((item) => item.severity === "error")) return findings

  if (!equal(candidate.subject, graph.subject)) add(findings, "error", "handoff", "subject-changed", "subject 未从候选池原样透传")
  if (graph.generation.sourceSchema !== "candidate-points/1.0") add(findings, "error", "graph", "bad-source-schema", "sourceSchema 必须为 candidate-points/1.0")
  if (graph.generation.candidateCount !== graph.points.length) add(findings, "error", "graph", "candidate-count-mismatch", "graph candidateCount 与points 数量不等")
  if (graph.generation.clusterCount !== graph.clusters.length) add(findings, "error", "graph", "cluster-count-mismatch", "clusterCount 与 clusters 数量不等")

  const candidateMap = new Map(candidate.candidates.map((point) => [point.id, point]))
  const pointMap = new Map()
  for (const point of graph.points) {
    if (pointMap.has(point?.id)) add(findings, "error", "graph", "duplicate-point-id", `图中点 id 重复: ${point?.id}`)
    pointMap.set(point?.id, point)
  }
  for (const id of candidateMap.keys()) if (!pointMap.has(id)) add(findings, "error", "handoff", "missing-point", `图中缺少候选点: ${id}`)
  for (const id of pointMap.keys()) if (!candidateMap.has(id)) add(findings, "error", "handoff", "extra-point", `图中新增了非候选点: ${id}`)
  for (const [id, source] of candidateMap) {
    const target = pointMap.get(id)
    if (!target) continue
    for (const field of CONTENT_FIELDS) if (!equal(source[field], target[field])) add(findings, "error", "handoff", "content-changed", `${id}.${field} 未原样透传`, { pointId: id, field })
  }

  const clusterIds = new Set()
  for (const cluster of graph.clusters) {
    if (!KEBAB.test(cluster?.id ?? "")) add(findings, "error", "graph", "bad-cluster-id", `簇 id 非法: ${cluster?.id}`)
    if (clusterIds.has(cluster?.id)) add(findings, "error", "graph", "duplicate-cluster-id", `簇 id 重复: ${cluster?.id}`)
    clusterIds.add(cluster?.id)
  }
  const dependents = new Map([...pointMap.keys()].map((id) => [id, 0]))
  const directedPairs = new Set()
  for (const point of graph.points) {
    if (!clusterIds.has(point.clusterId)) add(findings, "error", "graph", "bad-cluster-ref", `${point.id}.clusterId 指向不存在的簇`)
    if (!ALLOWED_ROLES.has(point.role)) add(findings, "error", "graph", "bad-role", `${point.id}.role 非法`)
    const prerequisites = Array.isArray(point.prerequisites) ? point.prerequisites : []
    const related = Array.isArray(point.related) ? point.related : []
    for (const prerequisite of prerequisites) {
      directedPairs.add(`${point.id}\u0000${prerequisite}`)
      if (dependents.has(prerequisite)) dependents.set(prerequisite, dependents.get(prerequisite) + 1)
      if (related.includes(prerequisite)) add(findings, "error", "relations", "relation-type-conflict", `${point.id} 与 ${prerequisite} 同时为前置和 related`)
    }
  }
  for (const point of graph.points) {
    for (const related of Array.isArray(point.related) ? point.related : []) {
      if (directedPairs.has(`${related}\u0000${point.id}`)) add(findings, "error", "relations", "relation-type-conflict", `${point.id} related ${related}，但 ${related} 依赖 ${point.id}`)
      if (!pointMap.get(related)?.related?.includes(point.id)) add(findings, "warning", "relations", "related-not-symmetric", `${point.id} related ${related} 未对称声明`)
    }
    if (point.role === "leaf" && (dependents.get(point.id) ?? 0) > 0) add(findings, "error", "roles", "leaf-has-dependents", `${point.id} 标为 leaf 但被其他点依赖`)
  }
  for (const cluster of graph.clusters) {
    const members = graph.points.filter((point) => point.clusterId === cluster.id)
    if (members.length && !members.some((point) => point.role === "trunk")) add(findings, "error", "roles", "cluster-without-trunk", `${cluster.id} 没有 trunk`)
  }

  const dag = spawnSync(process.execPath, [DAG_SCRIPT, graphFile, "--json"], { encoding: "utf8" })
  if (dag.status !== 0) {
    let detail = dag.stderr || dag.stdout
    try {
      const parsed = JSON.parse(dag.stdout)
      detail = parsed.findings
    } catch {}
    add(findings, "error", "graph", "dag-check-failed", "check-dag.mjs 校验失败", { detail })
  }
  return findings
}

function run(candidateFile, graphFile) {
  const candidate = load(candidateFile)
  const checked = validateCandidate(candidate)
  const findings = [...checked.findings]
  if (graphFile && !findings.some((item) => item.severity === "error")) {
    findings.push(...validateGraph(candidate, load(graphFile), graphFile))
  }
  return {
    ok: !findings.some((item) => item.severity === "error"),
    counts: {
      candidates: candidate?.candidates?.length ?? 0,
      sources: candidate?.sources?.length ?? 0,
      clusters: graphFile ? load(graphFile)?.clusters?.length ?? 0 : undefined,
      points: graphFile ? load(graphFile)?.points?.length ?? 0 : undefined,
      errors: findings.filter((item) => item.severity === "error").length,
      warnings: findings.filter((item) => item.severity === "warning").length,
    },
    findings,
  }
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "pipeline-check-"))
  try {
    const summary = "这是一个用于校验流水线脚本的基础知识点，能够被独立定义、讲解并设计考核问题。"
    const subject = { id: "demo", input: "测试", normalizedTitle: "测试", inputType: "course", language: "zh-CN", audience: "测试者", depth: "入门", scope: "脚本自测", exclusions: [] }
    const candidate = {
      schema_version: "candidate-points/1.0", subject,
      generation: { evidenceMode: "model-only", generatedAt: "2026-01-01", candidateCount: 2 },
      sources: [],
      candidates: [
        { id: "base", title: "基础", aliases: [], kind: "concept", shortSummary: summary, difficulty: "基础", importance: 0.9, keyTerms: ["基础", "定义"], sourceRefs: [], confidence: 0.6, scopeStatus: "core" },
        { id: "method", title: "方法", aliases: [], kind: "method", shortSummary: summary, difficulty: "中等", importance: 0.7, keyTerms: ["方法", "流程"], sourceRefs: [], confidence: 0.6, scopeStatus: "core" },
      ], reviewQueue: [],
    }
    const graph = {
      schema_version: "clustered-graph/1.0", subject,
      generation: { generatedAt: "2026-01-01", sourceSchema: "candidate-points/1.0", candidateCount: 2, clusterCount: 1, brokenCycleEdges: [] },
      clusters: [{ id: "demo", title: "测试", subtitle: "测试簇", description: "脚本自测簇", order: 0 }],
      points: [
        { id: "base", title: "基础", clusterId: "demo", role: "trunk", prerequisites: [], related: [], kind: "concept", shortSummary: summary, difficulty: "基础", importance: 0.9, keyTerms: ["基础", "定义"], aliases: [] },
        { id: "method", title: "方法", clusterId: "demo", role: "leaf", prerequisites: ["base"], related: [], kind: "method", shortSummary: summary, difficulty: "中等", importance: 0.7, keyTerms: ["方法", "流程"], aliases: [] },
      ],
    }
    const candidateFile = path.join(dir, "candidate.json")
    const graphFile = path.join(dir, "graph.json")
    writeFileSync(candidateFile, JSON.stringify(candidate))
    writeFileSync(graphFile, JSON.stringify(graph))
    const valid = run(candidateFile, graphFile)
    if (!valid.ok) throw new Error(`正例失败: ${JSON.stringify(valid.findings)}`)
    graph.points[1].related = ["base"]
    writeFileSync(graphFile, JSON.stringify(graph))
    const invalid = run(candidateFile, graphFile)
    if (!invalid.findings.some((item) => item.code === "relation-type-conflict")) throw new Error("未捕获关系互斥冲突")
    console.log("自测通过：正例合格，反例关系冲突已被拦截。")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args.includes("--self-test")) {
  selfTest()
  process.exit(0)
}
const asJson = args.includes("--json")
const files = args.filter((arg) => !arg.startsWith("--"))
if (files.length < 1 || files.length > 2) {
  console.error("用法: node check-pipeline.mjs <candidate-points.json> [clustered-graph.json] [--json]")
  process.exit(2)
}
try {
  const result = run(files[0], files[1])
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.ok ? "✅" : "❌"} 流水线校验${result.ok ? "通过" : "失败"}：${result.counts.candidates} 个候选点，${result.counts.clusters ?? 0} 个簇，${result.counts.errors} 个错误，${result.counts.warnings} 个警告。`)
    for (const item of result.findings) console.log(`  [${item.severity}] ${item.stage}/${item.code}: ${item.message}`)
  }
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
