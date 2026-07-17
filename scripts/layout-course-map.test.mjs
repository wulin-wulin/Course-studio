import assert from "node:assert/strict";
import test from "node:test";

import { createCourseMapLayout, MAP_LAYOUT_STYLES } from "./layout-course-map.mjs";

function polygonBox(polygon) {
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function boxDistance(left, right) {
  const dx = Math.max(0, left[0] - right[2], right[0] - left[2]);
  const dy = Math.max(0, left[1] - right[3], right[1] - left[3]);
  return Math.hypot(dx, dy);
}

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

test("九簇课程采用均衡紧凑岛屿布局，并为不同大小的树保留足够间距", () => {
  const clusterSizes = [3, 2, 1, 6, 5, 7, 4, 4, 3];
  const clusters = clusterSizes.map((_, index) => ({
    id: `cluster-${index + 1}`,
    title: `知识簇 ${index + 1}`,
    order: index + 1,
  }));
  const points = clusterSizes.flatMap((size, clusterIndex) => (
    Array.from({ length: size }, (_, pointIndex) => ({
      id: `point-${clusterIndex + 1}-${pointIndex + 1}`,
      title: `知识点 ${clusterIndex + 1}-${pointIndex + 1}`,
      clusterId: clusters[clusterIndex].id,
      importance: pointIndex === 0 ? 0.94 : 0.66 + (pointIndex % 3) * 0.08,
    }))
  ));
  const rolesById = Object.fromEntries(points.map((point, index) => [
    point.id,
    index % 5 === 0 ? "trunk" : index % 3 === 0 ? "leaf" : "branch",
  ]));

  const result = createCourseMapLayout({
    courseId: "nine-cluster-course",
    index: { schema_version: "1.0", courseId: "nine-cluster-course", clusters, points },
    rolesById,
    seed: "nine-cluster-course:test",
  }).index;
  const boxes = result.clusters.map((cluster) => polygonBox(cluster.polygon));
  const allX = boxes.flatMap((box) => [box[0], box[2]]);
  const allY = boxes.flatMap((box) => [box[1], box[3]]);
  const width = Math.max(...allX) - Math.min(...allX);
  const height = Math.max(...allY) - Math.min(...allY);
  const pairGaps = [];
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      pairGaps.push(boxDistance(boxes[left], boxes[right]));
    }
  }

  assert.ok(width >= 1_800 && width <= 3_000, `簇总宽度不合理: ${width}`);
  assert.ok(height >= 1_400 && height <= 2_400, `簇总高度不合理: ${height}`);
  assert.ok(width / height >= 0.9 && width / height <= 1.55, `布局比例不均衡: ${width / height}`);
  assert.ok(Math.min(...pairGaps) >= 70, `知识簇过近: ${Math.min(...pairGaps)}`);

  const organicGap = MAP_LAYOUT_STYLES.organic.pointGap * 0.9;
  for (const cluster of clusters) {
    const members = result.points.filter((point) => point.clusterId === cluster.id);
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const first = members[left];
        const second = members[right];
        const distance = Math.hypot(first.pos[0] - second.pos[0], first.pos[1] - second.pos[1]);
        const scaleAverage = ((first.scale ?? 1) + (second.scale ?? 1)) / 2;
        assert.ok(
          distance >= organicGap * scaleAverage - 1,
          `${cluster.id} 内知识点过近: ${distance}`,
        );
      }
    }
  }

  assert.doesNotThrow(() => createCourseMapLayout({
    courseId: "nine-cluster-course",
    index: { schema_version: "1.0", courseId: "nine-cluster-course", clusters, points },
    rolesById,
    seed: "nine-cluster-course:alternate-seed",
  }));
});
