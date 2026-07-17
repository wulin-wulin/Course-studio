import assert from "node:assert/strict";
import test from "node:test";

import { createCourseMapLayout } from "./layout-course-map.mjs";

test("课程簇分类升级后自动回退通用布局，不依赖旧版专用锚点", () => {
  const index = {
    schema_version: "1.0",
    courseId: "software-engineering",
    clusters: [
      { id: "engineering-foundations", title: "软件工程基础", order: 1 },
      { id: "testing-quality", title: "测试与质量", order: 2 },
    ],
    points: [
      {
        id: "software-engineering-overview",
        title: "软件工程概览",
        clusterId: "engineering-foundations",
        importance: 0.95,
      },
      {
        id: "testing-fundamentals",
        title: "测试基础",
        clusterId: "testing-quality",
        importance: 0.85,
      },
    ],
  };

  const first = createCourseMapLayout({
    courseId: "software-engineering",
    index,
    rolesById: {
      "software-engineering-overview": "trunk",
      "testing-fundamentals": "trunk",
    },
    seed: "software-engineering:course-creator:v2",
  });
  const second = createCourseMapLayout({
    courseId: "software-engineering",
    index,
    rolesById: {
      "software-engineering-overview": "trunk",
      "testing-fundamentals": "trunk",
    },
    seed: "software-engineering:course-creator:v2",
  });

  assert.equal(first.index.clusters.length, 2);
  assert.equal(first.index.points.length, 2);
  assert.ok(first.index.clusters.every((cluster) => cluster.polygon.length >= 5));
  assert.ok(first.index.points.every((point) => point.pos.length === 2));
  assert.deepEqual(first.index, second.index);
});
