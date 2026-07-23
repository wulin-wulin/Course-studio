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
  "publish",
] as const

type Action = (typeof ACTION_NAMES)[number]

type Invocation = {
  script: string
  args: (courseId: string) => string[]
}

const ACTIONS: Record<Action, Invocation> = {
  init: {
    script: "init-course-pipeline.mjs",
    args: (courseId) => [courseId],
  },
  "init-points": {
    script: "init-course-pipeline.mjs",
    args: (courseId) => [courseId, "--stage", "points"],
  },
  "init-animation-manifest": {
    script: "init-course-pipeline.mjs",
    args: (courseId) => [courseId, "--stage", "animation-manifest"],
  },
  "init-animations": {
    script: "init-course-pipeline.mjs",
    args: (courseId) => [courseId, "--stage", "animations"],
  },
  "review-knowledge-points": {
    script: "prepare-course-review.mjs",
    args: (courseId) => ["knowledge-points", courseId],
  },
  "review-knowledge-graph": {
    script: "prepare-course-review.mjs",
    args: (courseId) => ["knowledge-graph", courseId],
  },
  "validate-index": pipelineStep("validate-index"),
  "validate-points": pipelineStep("validate-points"),
  "validate-animations": pipelineStep("validate-animations"),
  "validate-all": pipelineStep("validate-all"),
  "sync-index": pipelineStep("sync-index"),
  "sync-index-check": pipelineStep("sync-index-check"),
  "build-animation-registry": pipelineStep("build-animation-registry"),
  "assemble-graph": pipelineStep("assemble-graph"),
  "assemble-graph-check": pipelineStep("assemble-graph-check"),
  "check-graph": pipelineStep("check-graph"),
  "check-graph-json": pipelineStep("check-graph-json"),
  "check-content-all": pipelineStep("check-content-all"),
  "check-pipeline-json": pipelineStep("check-pipeline-json"),
  "check-pipeline-all": pipelineStep("check-pipeline-all"),
  "check-pipeline-all-json": pipelineStep("check-pipeline-all-json"),
  publish: {
    script: "publish-course-pipeline.mjs",
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

function pipelineStep(action: string): Invocation {
  return {
    script: "run-course-pipeline-step.mjs",
    args: (courseId) => [action, courseId],
  }
}

function assertTrustedScript(directory: string, scriptName: string): string {
  const root = path.resolve(directory)
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("课程流水线工作区必须是普通目录")
  }

  let current = root
  for (const [index, segment] of [".opencode", "tools", scriptName].entries()) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) {
      throw new Error(`缺少受信课程流水线脚本：${scriptName}`)
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`受信课程流水线路径不允许符号链接：${segment}`)
    }
    if (index < 2 && !stat.isDirectory()) {
      throw new Error(`受信课程流水线路径不是目录：${segment}`)
    }
    if (index === 2 && !stat.isFile()) {
      throw new Error(`受信课程流水线脚本不是普通文件：${scriptName}`)
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
