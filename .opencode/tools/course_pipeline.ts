import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

const COURSE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const ACTION_NAMES = [
  "init",
  "init-points",
  "init-animation-manifest",
  "init-animations",
  "review-knowledge-points",
  "review-knowledge-graph",
  "validate-index",
  "validate-points",
  "validate-animations",
  "validate-all",
  "finalize-points",
  "sync-index",
  "sync-index-check",
  "build-animation-registry",
  "assemble-graph",
  "assemble-graph-check",
  "check-graph",
  "check-graph-json",
  "check-content-all",
  "check-pipeline-json",
  "check-pipeline-all",
  "check-pipeline-all-json",
  "release-check",
  "publish",
] as const

type Action = (typeof ACTION_NAMES)[number]

type Invocation = {
  script: readonly string[]
  args: (courseId: string) => string[]
}

const TOOL_SCRIPT_ROOT = [".opencode", "tools"] as const
const CONTENT_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "candidate-knowledge-point-generator",
  "scripts",
] as const
const GRAPH_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "knowledge-cluster-builder",
  "knowledge-cluster-builder",
  "scripts",
] as const
const ORCHESTRATOR_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "knowledge-pipeline-orchestrator",
  "scripts",
] as const

function toolScript(name: string): readonly string[] {
  return [...TOOL_SCRIPT_ROOT, name]
}

function contentPaths(courseId: string) {
  return {
    contentRoot: `pipeline/${courseId}/course-content`,
    graphFile: `pipeline/${courseId}/clustered-graph.json`,
  }
}

function validatorScript(
  root: readonly string[],
  name: string,
  args: (paths: ReturnType<typeof contentPaths>) => string[],
): Invocation {
  return {
    script: [...root, name],
    args: (courseId) => args(contentPaths(courseId)),
  }
}

const ACTIONS: Record<Action, Invocation> = {
  init: {
    script: toolScript("init-course-pipeline.mjs"),
    args: (courseId) => [courseId],
  },
  "init-points": {
    script: toolScript("init-course-pipeline.mjs"),
    args: (courseId) => [courseId, "--stage", "points"],
  },
  "init-animation-manifest": {
    script: toolScript("init-course-pipeline.mjs"),
    args: (courseId) => [courseId, "--stage", "animation-manifest"],
  },
  "init-animations": {
    script: toolScript("init-course-pipeline.mjs"),
    args: (courseId) => [courseId, "--stage", "animations"],
  },
  "review-knowledge-points": {
    script: toolScript("prepare-course-review.mjs"),
    args: (courseId) => ["knowledge-points", courseId],
  },
  "review-knowledge-graph": {
    script: toolScript("prepare-course-review.mjs"),
    args: (courseId) => ["knowledge-graph", courseId],
  },
  "validate-index": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "validate_output.mjs",
    ({ contentRoot }) => ["--root", contentRoot, "--phase", "index"],
  ),
  "validate-points": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "validate_output.mjs",
    ({ contentRoot }) => ["--root", contentRoot, "--phase", "points"],
  ),
  "validate-animations": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "validate_output.mjs",
    ({ contentRoot }) => ["--root", contentRoot, "--phase", "animations"],
  ),
  "validate-all": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "validate_output.mjs",
    ({ contentRoot }) => ["--root", contentRoot, "--phase", "all"],
  ),
  "finalize-points": {
    script: toolScript("run-course-pipeline-step.mjs"),
    args: (courseId) => ["finalize-points", courseId],
  },
  "sync-index": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "sync_index_from_points.mjs",
    ({ contentRoot }) => ["--root", contentRoot],
  ),
  "sync-index-check": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "sync_index_from_points.mjs",
    ({ contentRoot }) => ["--root", contentRoot, "--check"],
  ),
  "build-animation-registry": validatorScript(
    CONTENT_SCRIPT_ROOT,
    "build_animation_registry.mjs",
    ({ contentRoot }) => ["--root", contentRoot],
  ),
  "assemble-graph": validatorScript(
    GRAPH_SCRIPT_ROOT,
    "assemble-graph-points.mjs",
    ({ contentRoot, graphFile }) => [contentRoot, graphFile],
  ),
  "assemble-graph-check": validatorScript(
    GRAPH_SCRIPT_ROOT,
    "assemble-graph-points.mjs",
    ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--check"],
  ),
  "check-graph": validatorScript(
    GRAPH_SCRIPT_ROOT,
    "check-graph.mjs",
    ({ graphFile }) => [graphFile],
  ),
  "check-graph-json": validatorScript(
    GRAPH_SCRIPT_ROOT,
    "check-graph.mjs",
    ({ graphFile }) => [graphFile, "--json"],
  ),
  "check-content-all": validatorScript(
    ORCHESTRATOR_SCRIPT_ROOT,
    "check-pipeline.mjs",
    ({ contentRoot }) => [contentRoot, "--phase", "all"],
  ),
  "check-pipeline-json": validatorScript(
    ORCHESTRATOR_SCRIPT_ROOT,
    "check-pipeline.mjs",
    ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--json"],
  ),
  "check-pipeline-all": validatorScript(
    ORCHESTRATOR_SCRIPT_ROOT,
    "check-pipeline.mjs",
    ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--phase", "all"],
  ),
  "check-pipeline-all-json": validatorScript(
    ORCHESTRATOR_SCRIPT_ROOT,
    "check-pipeline.mjs",
    ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--phase", "all", "--json"],
  ),
  "release-check": {
    script: toolScript("publish-course-pipeline.mjs"),
    args: (courseId) => [courseId, "--check"],
  },
  publish: {
    script: toolScript("publish-course-pipeline.mjs"),
    args: (courseId) => [courseId],
  },
}

const OUTLINE_ACTIONS = new Set<Action>([
  "init",
  "validate-index",
  "review-knowledge-points",
])
const CREATOR_ACTIONS = new Set<Action>(ACTION_NAMES)
const AGENT_ACTIONS: Readonly<Record<string, ReadonlySet<Action>>> = {
  "course-outline-creator": OUTLINE_ACTIONS,
  "course-creator": CREATOR_ACTIONS,
}

function assertTrustedScript(directory: string, segments: readonly string[]): string {
  const root = path.resolve(directory)
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("课程流水线工作区必须是普通目录")
  }

  let current = root
  for (const [index, segment] of segments.entries()) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
    ) {
      throw new Error("受信课程流水线脚本路径不合法")
    }
    current = path.join(current, segment)
    if (!fs.existsSync(current)) {
      throw new Error(`缺少受信课程流水线脚本：${segments.join("/")}`)
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`受信课程流水线路径不允许符号链接：${segment}`)
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`受信课程流水线路径不是目录：${segment}`)
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`受信课程流水线脚本不是普通文件：${segments.join("/")}`)
    }
  }
  return current
}

function outputText(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
}

export default tool({
  description: "Run one fixed Course Studio course-generation pipeline action.",
  args: {
    action: tool.schema.enum(ACTION_NAMES).describe("Fixed course pipeline action"),
    courseId: tool.schema
      .string()
      .regex(COURSE_ID_PATTERN)
      .describe("Lowercase kebab-case course ID"),
  },
  async execute(args, context) {
    const action = args.action as Action
    const allowed = AGENT_ACTIONS[context.agent]
    if (!allowed?.has(action)) {
      throw new Error(`Agent ${context.agent || "<unknown>"} 无权执行课程流水线动作 ${action}`)
    }
    if (!COURSE_ID_PATTERN.test(args.courseId) || !(action in ACTIONS)) {
      throw new Error("课程流水线参数不合法")
    }

    const invocation = ACTIONS[action]
    const script = assertTrustedScript(context.directory, invocation.script)
    const child = Bun.spawn(["node", script, ...invocation.args(args.courseId)], {
      cwd: path.resolve(context.directory),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = outputText(stdout, stderr)
    if (exitCode !== 0) {
      throw new Error(
        `课程流水线动作 ${action} 失败（退出码 ${exitCode}）${output ? `\n${output}` : ""}`,
      )
    }
    return output || JSON.stringify({ action, courseId: args.courseId, status: "completed" })
  },
})
