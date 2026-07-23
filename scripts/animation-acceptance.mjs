import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ANIMATION_ACCEPTANCE_SCHEMA = "course-animation-acceptance/1.0";

const TRACKED_FILES = [
  "generation/animation-manifest.json",
  "src/components/AnimationBlock.css",
  "src/components/AnimationBlock.tsx",
  "src/data/courseKnowledge.ts",
];

function trackedAnimationFiles(contentRoot) {
  const files = [];
  for (const relativePath of TRACKED_FILES) {
    const filePath = path.join(contentRoot, ...relativePath.split("/"));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push(relativePath);
    }
  }

  const animationsRoot = path.join(contentRoot, "src", "animations");
  if (fs.existsSync(animationsRoot) && fs.statSync(animationsRoot).isDirectory()) {
    for (const entry of fs.readdirSync(animationsRoot, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".css"))) {
        files.push(`src/animations/${entry.name}`);
      }
    }
  }
  return files.sort();
}

export function computeAnimationArtifactHash(contentRoot) {
  const digest = createHash("sha256");
  for (const relativePath of trackedAnimationFiles(contentRoot)) {
    const filePath = path.join(contentRoot, ...relativePath.split("/"));
    const fileDigest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    digest.update(relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(fileDigest, "ascii");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

export function animationAcceptancePath(workspaceRoot, courseId) {
  return path.join(
    workspaceRoot,
    ".course-studio",
    "gates",
    courseId,
    "animation-acceptance.json",
  );
}

export function validateAnimationAcceptance({
  workspaceRoot,
  contentRoot,
  courseId,
  animations,
  readJson,
  fail,
}) {
  if (animations.length === 0) return;

  const acceptancePath = animationAcceptancePath(workspaceRoot, courseId);
  if (!fs.existsSync(acceptancePath)) {
    fail(
      "G5 动画验收未完成：动画清单非空，但系统没有签发人工验收凭据。"
        + "请实际检查动画的重播、状态推进、低动态和响应式布局后，在对话中确认验收；"
        + "不得跳过后直接发布。",
    );
  }

  const acceptance = readJson(acceptancePath, "动画验收凭据");
  if (
    acceptance?.schema_version !== ANIMATION_ACCEPTANCE_SCHEMA
    || acceptance?.courseId !== courseId
    || acceptance?.status !== "accepted"
    || !Number.isSafeInteger(acceptance?.animationCount)
    || acceptance.animationCount !== animations.length
  ) {
    fail("G5 动画验收凭据格式无效或与当前课程不一致，不能发布");
  }

  const currentHash = computeAnimationArtifactHash(contentRoot);
  if (acceptance.artifactHash !== currentHash) {
    fail(
      "G5 动画验收凭据已失效：动画清单、组件源码或注册层在验收后发生了变化，"
        + "必须重新实际验收。",
    );
  }
}
