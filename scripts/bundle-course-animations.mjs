#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ANIMATION_TYPE_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const RUNTIME_SCHEMA = "course-animation-runtime/1.0";
const RUNTIME_FILES = ["runtime.js", "runtime.css"];
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ancestors(start) {
  const values = [];
  let current = path.resolve(start);
  while (true) {
    values.push(current);
    const parent = path.dirname(current);
    if (parent === current) return values;
    current = parent;
  }
}

function frontendPackageAt(candidate) {
  const packagePath = path.join(candidate, "package.json");
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) return null;
  try {
    const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return value?.name === "@course-forest/frontend" ? candidate : null;
  } catch {
    return null;
  }
}

function findFrontendRoot(projectRootHint) {
  const starts = [
    projectRootHint,
    process.env.COURSE_STUDIO_PROJECT_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter(Boolean);
  const visited = new Set();
  for (const start of starts) {
    for (const candidate of ancestors(start)) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const direct = frontendPackageAt(candidate);
      if (direct) return direct;
      const nested = frontendPackageAt(path.join(candidate, "packages", "frontend"));
      if (nested) return nested;
    }
  }
  fail(
    "找不到 Course Studio 前端依赖。请先在 packages/frontend 安装依赖，"
      + "并通过 COURSE_STUDIO_PROJECT_ROOT 指向项目根目录。",
  );
}

async function loadEsbuild(frontendRoot) {
  const modulePath = path.join(frontendRoot, "node_modules", "esbuild", "lib", "main.js");
  if (!fs.existsSync(modulePath) || !fs.statSync(modulePath).isFile()) {
    fail("缺少动画生产构建器 esbuild；请先在 packages/frontend 执行 npm install");
  }
  return import(pathToFileURL(modulePath).href);
}

function assertSafeSourceTree(contentRoot) {
  const sourceRoot = path.join(contentRoot, "src");
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory() || fs.lstatSync(sourceRoot).isSymbolicLink()) {
    fail("动画内容包缺少安全的 src 目录");
  }
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || fs.lstatSync(candidate).isSymbolicLink()) {
        fail(`动画源码不允许符号链接：${path.relative(contentRoot, candidate)}`);
      }
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
}

function validateAnimationManifest(contentRoot, manifest) {
  if (manifest?.schema_version !== "course-content-animations/1.0") {
    fail("animation-manifest.json 的 schema_version 无效");
  }
  if (!Array.isArray(manifest.animations)) {
    fail("animation-manifest.json.animations 必须是数组");
  }
  const types = new Set();
  const components = new Set();
  for (const animation of manifest.animations) {
    const type = animation?.type;
    const component = animation?.component;
    if (!ANIMATION_TYPE_PATTERN.test(type ?? "")) fail(`非法 animationType：${type ?? "<empty>"}`);
    if (!COMPONENT_PATTERN.test(component ?? "")) fail(`非法动画组件名：${component ?? "<empty>"}`);
    if (types.has(type)) fail(`animationType 重复：${type}`);
    if (components.has(component)) fail(`动画组件重复：${component}`);
    types.add(type);
    components.add(component);
    for (const extension of ["tsx", "css"]) {
      const sourcePath = path.join(contentRoot, "src", "animations", `${component}.${extension}`);
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile() || fs.lstatSync(sourcePath).isSymbolicLink()) {
        fail(`动画 ${type} 缺少安全的 ${component}.${extension}`);
      }
    }
  }
  return manifest.animations;
}

function restrictedImportsPlugin(contentRoot, frontendRoot) {
  const sourceRoot = path.resolve(contentRoot);
  const frontendModules = path.resolve(frontendRoot, "node_modules");
  const isAllowedPackage = (specifier) => (
    specifier === "react"
    || specifier === "react-dom/client"
    || specifier === "react/jsx-runtime"
    || specifier === "react/jsx-dev-runtime"
    || specifier === "three"
    || specifier.startsWith("three/")
  );

  return {
    name: "course-animation-import-boundary",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer) return undefined;
        const importer = path.resolve(args.importer);
        if (isInside(frontendModules, importer)) return undefined;
        if (!isInside(sourceRoot, importer)) {
          return { errors: [{ text: `动画构建遇到来源不明的模块：${args.importer}` }] };
        }
        if (isAllowedPackage(args.path)) return undefined;
        if (args.path.startsWith(".")) {
          const target = path.resolve(path.dirname(importer), args.path);
          if (isInside(sourceRoot, target)) return undefined;
        }
        return {
          errors: [{ text: `动画源码引用了未授权依赖或越界路径：${args.path}` }],
        };
      });
    },
  };
}

function runtimeEntrySource() {
  return `
import React, { Component } from "react";
import { createRoot } from "react-dom/client";
import AnimationBlock from "./src/components/AnimationBlock.tsx";

const CHANNEL = "course-studio-animation-v1";
const send = (kind, payload = {}) => {
  window.parent.postMessage({ channel: CHANNEL, kind, ...payload }, "*");
};

class RuntimeErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    send("error", { message: error instanceof Error ? error.message : "动画运行失败" });
  }

  render() {
    if (this.state.error) {
      return <div className="course-animation-runtime__error" role="alert">动画暂时无法显示，请参考正文说明。</div>;
    }
    return this.props.children;
  }
}

const mount = document.getElementById("root");
if (!mount) throw new Error("动画运行时缺少挂载节点");
const animationType = new URLSearchParams(window.location.search).get("type") || "none";
createRoot(mount).render(
  <RuntimeErrorBoundary>
    <AnimationBlock type={animationType} />
  </RuntimeErrorBoundary>,
);

let lastHeight = 0;
const reportHeight = () => {
  const height = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight || 0,
    mount.scrollHeight,
  );
  if (height !== lastHeight) {
    lastHeight = height;
    send("resize", { height });
  }
};
const observer = new ResizeObserver(reportHeight);
observer.observe(document.documentElement);
observer.observe(mount);
window.addEventListener("load", reportHeight, { once: true });
window.addEventListener("error", (event) => send("error", { message: event.message || "动画运行失败" }));
window.addEventListener("unhandledrejection", () => send("error", { message: "动画运行失败" }));
queueMicrotask(reportHeight);
`;
}

const RUNTIME_SHELL_CSS = `
:root { color-scheme: light; background: transparent; }
html, body { min-width: 0; margin: 0; background: transparent; color: #24342f; }
body { padding: 2px; font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
*, *::before, *::after { box-sizing: border-box; }
#root { min-width: 0; width: 100%; }
.course-animation-runtime__error {
  padding: 18px;
  border: 1px solid #e1b8a4;
  border-radius: 10px;
  background: #fff5ef;
  color: #8b4930;
  font-size: 14px;
}
`;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateMetafileInputs(metafile, contentRoot, frontendRoot, entryPath) {
  const modulesRoot = path.join(frontendRoot, "node_modules");
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const absolute = path.resolve(contentRoot, input);
    if (
      absolute !== path.resolve(entryPath)
      && !isInside(contentRoot, absolute)
      && !isInside(modulesRoot, absolute)
    ) {
      fail(`动画 bundle 包含越界输入：${input}`);
    }
  }
}

export async function buildCourseAnimationRuntime({
  contentRoot,
  outputDirectory,
  animationManifest,
  projectRootHint,
}) {
  const resolvedContentRoot = path.resolve(contentRoot);
  const resolvedOutput = path.resolve(outputDirectory);
  assertSafeSourceTree(resolvedContentRoot);
  const animations = validateAnimationManifest(resolvedContentRoot, animationManifest);
  if (animations.length === 0) return null;

  if (fs.existsSync(resolvedOutput) && fs.lstatSync(resolvedOutput).isSymbolicLink()) {
    fail("拒绝将动画发布到符号链接目录");
  }
  fs.mkdirSync(resolvedOutput, { recursive: true });
  if (fs.readdirSync(resolvedOutput).length > 0) fail("动画发布目录必须为空");

  const frontendRoot = findFrontendRoot(projectRootHint);
  const esbuild = await loadEsbuild(frontendRoot);
  const entryPath = path.join(resolvedContentRoot, ".course-studio-animation-entry.tsx");
  if (fs.existsSync(entryPath)) fail("动画内容包包含保留文件 .course-studio-animation-entry.tsx");
  const javascriptPath = path.join(resolvedOutput, "runtime.js");
  const stylesheetPath = path.join(resolvedOutput, "runtime.css");

  let buildResult;
  try {
    fs.writeFileSync(entryPath, runtimeEntrySource(), "utf8");
    buildResult = await esbuild.build({
      absWorkingDir: resolvedContentRoot,
      entryPoints: [entryPath],
      outfile: javascriptPath,
      bundle: true,
      charset: "utf8",
      define: { "process.env.NODE_ENV": '"production"' },
      jsx: "automatic",
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
      minify: true,
      nodePaths: [path.join(frontendRoot, "node_modules")],
      platform: "browser",
      plugins: [restrictedImportsPlugin(resolvedContentRoot, frontendRoot)],
      sourcemap: false,
      target: ["es2020"],
      treeShaking: true,
    });
    validateMetafileInputs(buildResult.metafile, resolvedContentRoot, frontendRoot, entryPath);
  } catch (error) {
    const detail = Array.isArray(error?.errors) && error.errors.length > 0
      ? (await esbuild.formatMessages(error.errors, { kind: "error", color: false })).join("\n")
      : error instanceof Error ? error.message : String(error);
    fail(`教学动画生产构建失败：\n${detail}`);
  } finally {
    fs.rmSync(entryPath, { force: true });
  }

  if (
    !fs.existsSync(javascriptPath)
    || !fs.statSync(javascriptPath).isFile()
    || !fs.existsSync(stylesheetPath)
    || !fs.statSync(stylesheetPath).isFile()
  ) {
    fail("教学动画构建未生成完整的 runtime.js/runtime.css");
  }
  fs.writeFileSync(
    stylesheetPath,
    `${RUNTIME_SHELL_CSS}\n${fs.readFileSync(stylesheetPath, "utf8")}`,
    "utf8",
  );

  const assets = {};
  for (const fileName of RUNTIME_FILES) {
    const value = fs.readFileSync(path.join(resolvedOutput, fileName));
    if (value.length === 0 || value.length > MAX_BUNDLE_BYTES) {
      fail(`教学动画资产大小异常：${fileName}`);
    }
    assets[fileName] = { bytes: value.length, sha256: sha256(value) };
  }
  const runtimeManifest = {
    schema_version: RUNTIME_SCHEMA,
    source_schema_version: animationManifest.schema_version,
    format: "sandboxed-iframe",
    animations,
    assets,
  };
  fs.writeFileSync(
    path.join(resolvedOutput, "manifest.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    "utf8",
  );
  return runtimeManifest;
}
