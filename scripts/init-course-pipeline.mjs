#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(message);
}

function main() {
  const courseId = process.argv[2];
  if (!courseId || !ID_PATTERN.test(courseId)) {
    fail("用法：node .opencode/tools/init-course-pipeline.mjs <course-id>");
  }

  const root = process.cwd();
  const pipelineRoot = path.join(root, "pipeline");
  const targetDirectory = path.join(pipelineRoot, courseId);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const created = [];
  for (const fileName of ["candidate-points.json", "clustered-graph.json"]) {
    const filePath = path.join(targetDirectory, fileName);
    if (fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, "{}\n", { encoding: "utf8", flag: "wx" });
    created.push(`pipeline/${courseId}/${fileName}`);
  }

  process.stdout.write(`${JSON.stringify({ courseId, created, directory: `pipeline/${courseId}` })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
