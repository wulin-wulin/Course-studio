import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const courseRoot = path.join(projectRoot, "course-data", "courses");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 空间风格只影响簇的形状、位置与知识点的位置/大小；不会改动课程内容、关系或配色。
 * 后续可在此表新增新的视觉分布策略。
 */
export const MAP_LAYOUT_STYLES = {
  organic: {
    description: "岛屿式不规则簇，适合知识森林的自然分布",
    vertices: [5, 9],
    clusterJitter: 72,
    clusterGap: [150, 135],
    pointSpread: 0.84,
    pointGap: 150,
    scale: { trunk: 1.16, branch: 0.86, leaf: 0.6 },
  },
  compact: {
    description: "更紧凑的岛屿分布，适合知识簇较少或需要快速总览的课程",
    vertices: [5, 7],
    clusterJitter: 44,
    clusterGap: [118, 104],
    pointSpread: 0.76,
    pointGap: 126,
    scale: { trunk: 1.1, branch: 0.82, leaf: 0.58 },
  },
};

// 软件工程课程沿课程主线组织：基础居中，需求/设计在上游，测试/质量/运维在下游。
// 其他课程会自动使用通用岛屿式锚点，无需为每门课程编写配置。
const COURSE_ANCHORS = {
  "software-engineering": {
    "boundary-topics": { center: [720, 650], radius: [250, 210], phase: -0.35 },
    "process-models": { center: [1440, 780], radius: [340, 270], phase: 0.16 },
    requirements: { center: [2320, 760], radius: [370, 290], phase: -0.22 },
    "software-design": { center: [3110, 930], radius: [350, 280], phase: 0.28 },
    "project-management": { center: [760, 1450], radius: [270, 230], phase: 0.42 },
    "se-fundamentals": { center: [1750, 1450], radius: [360, 285], phase: -0.18 },
    "software-construction": { center: [2550, 1470], radius: [320, 260], phase: 0.12 },
    "software-security": { center: [3370, 1590], radius: [250, 215], phase: -0.32 },
    "configuration-management": { center: [890, 2220], radius: [270, 235], phase: 0.22 },
    "quality-and-maintenance": { center: [1660, 2300], radius: [370, 300], phase: -0.1 },
    "software-testing": { center: [2440, 2250], radius: [350, 290], phase: 0.26 },
    devops: { center: [3230, 2420], radius: [365, 300], phase: -0.14 },
  },
};

function fail(message) {
  throw new Error(message);
}

function seededRandom(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    const intersects = (y > point[1]) !== (previousY > point[1])
      && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function sequenceEdges(ids, edges) {
  if (!Array.isArray(edges)) return [];
  const idSet = new Set(ids);
  const seen = new Set();
  const result = [];
  for (const edge of edges) {
    const fromId = edge?.fromId;
    const toId = edge?.toId;
    if (
      typeof fromId !== "string"
      || typeof toId !== "string"
      || fromId === toId
      || !idSet.has(fromId)
      || !idSet.has(toId)
    ) continue;
    const key = `${fromId}\u0000${toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ fromId, toId });
  }
  return result;
}

function stableTopologicalOrder(ids, edges) {
  const position = new Map(ids.map((id, index) => [id, index]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of sequenceEdges(ids, edges)) {
    outgoing.get(edge.fromId).push(edge.toId);
    indegree.set(edge.toId, indegree.get(edge.toId) + 1);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0);
  const result = [];
  while (ready.length > 0) {
    ready.sort((left, right) => position.get(left) - position.get(right));
    const current = ready.shift();
    result.push(current);
    for (const target of outgoing.get(current)) {
      const nextIndegree = indegree.get(target) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) ready.push(target);
    }
  }

  // Publication rejects sequence cycles. Keeping unresolved ids in their
  // original order makes this standalone helper safe for older course data.
  const resolved = new Set(result);
  return [...result, ...ids.filter((id) => !resolved.has(id))];
}

function sequenceFirstOrder(ids, edges) {
  const validEdges = sequenceEdges(ids, edges);
  if (validEdges.length === 0) return [...ids];
  const sequencedIds = new Set(validEdges.flatMap((edge) => [edge.fromId, edge.toId]));
  const participating = ids.filter((id) => sequencedIds.has(id));
  const ordered = stableTopologicalOrder(participating, validEdges);
  return [...ordered, ...ids.filter((id) => !sequencedIds.has(id))];
}

function orientation(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1])
    - (second[1] - first[1]) * (third[0] - first[0]);
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
  const epsilon = 1e-7;
  const firstSideStart = orientation(firstStart, firstEnd, secondStart);
  const firstSideEnd = orientation(firstStart, firstEnd, secondEnd);
  const secondSideStart = orientation(secondStart, secondEnd, firstStart);
  const secondSideEnd = orientation(secondStart, secondEnd, firstEnd);
  return firstSideStart * firstSideEnd < -epsilon
    && secondSideStart * secondSideEnd < -epsilon;
}

function genericAnchors(clusters, points, style, seed, sequenceAware = false) {
  if (clusters.length === 0) return {};
  const random = seededRandom(`${seed}:anchors`);
  const memberCountByCluster = new Map(clusters.map((cluster) => [cluster.id, 0]));
  for (const point of points) {
    memberCountByCluster.set(
      point.clusterId,
      (memberCountByCluster.get(point.clusterId) ?? 0) + 1,
    );
  }

  // Round instead of ceil so perfect squares remain balanced (9 -> 3 x 3).
  // The former 9 -> 4 x 3 grid left most of the last row empty and made the
  // whole map look much wider than its useful content.
  const columns = Math.max(2, Math.round(Math.sqrt(clusters.length * 1.15)));
  const rows = Math.ceil(clusters.length / columns);
  const baseRowSize = Math.floor(clusters.length / rows);
  const fullerRows = clusters.length % rows;
  const rowSizes = Array.from(
    { length: rows },
    (_, row) => baseRowSize + (row < fullerRows ? 1 : 0),
  );

  const entries = clusters.map((cluster) => {
    const members = memberCountByCluster.get(cluster.id) ?? 0;
    const density = Math.sqrt(Math.max(1, members));
    // Dense clusters receive more room, while a one-point cluster no longer
    // occupies nearly the same island as a seven-point cluster. makePolygon
    // adds a final small per-member allowance below.
    const radius = [
      style.pointGap * 1.25 + density * 38 + random() * 32,
      style.pointGap + density * 30 + random() * 26,
    ];
    const memberAllowanceScale = style.pointGap / MAP_LAYOUT_STYLES.organic.pointGap;
    return {
      cluster,
      members,
      radius,
      footprintX: radius[0] + members * 11 * memberAllowanceScale,
      footprintY: radius[1] + members * 9 * memberAllowanceScale,
      phase: random() * Math.PI * 2,
    };
  });

  const packedRows = [];
  let entryIndex = 0;
  for (const [rowIndex, rowSize] of rowSizes.entries()) {
    const logicalItems = entries.slice(entryIndex, entryIndex + rowSize);
    entryIndex += rowSize;
    // Sequence-aware maps alternate each physical row so reading continues at
    // the nearest edge instead of drawing a long diagonal across the map.
    const items = sequenceAware && rowIndex % 2 !== 0
      ? [...logicalItems].reverse()
      : logicalItems;
    let cursorX = 0;
    let previousFootprintX = 0;
    for (const [column, item] of items.entries()) {
      if (column === 0) cursorX = item.footprintX;
      else {
        cursorX += previousFootprintX + style.clusterGap[0] + item.footprintX;
      }
      item.localX = cursorX;
      previousFootprintX = item.footprintX;
    }
    const width = items.length > 0
      ? items.at(-1).localX + items.at(-1).footprintX
      : 0;
    packedRows.push({ items, width, halfHeight: Math.max(...items.map((item) => item.footprintY)) });
  }

  const widestRow = Math.max(...packedRows.map((row) => row.width));
  let cursorY = 0;
  let previousHalfHeight = 0;
  for (const [rowIndex, row] of packedRows.entries()) {
    if (rowIndex === 0) cursorY = row.halfHeight;
    else cursorY += previousHalfHeight + style.clusterGap[1] + row.halfHeight;
    row.localY = cursorY;
    previousHalfHeight = row.halfHeight;
  }
  const totalHeight = packedRows.length > 0
    ? packedRows.at(-1).localY + packedRows.at(-1).halfHeight
    : 0;

  const result = {};
  for (const [rowIndex, row] of packedRows.entries()) {
    const centeredStart = (widestRow - row.width) / 2;
    const stagger = (random() - 0.5) * style.clusterJitter
      + (rowIndex % 2 === 0 ? -style.clusterJitter * 0.12 : style.clusterJitter * 0.12);
    for (const item of row.items) {
      const jitterX = (random() - 0.5) * style.clusterJitter * 0.34;
      const jitterY = (random() - 0.5) * style.clusterJitter * 0.5;
      result[item.cluster.id] = {
        center: [
          Math.round(2000 - widestRow / 2 + centeredStart + item.localX + stagger + jitterX),
          // The scene camera projects larger world-y values toward the top of
          // the default overview. Place the first logical row there so the
          // reading path starts at the visual upper-left corner.
          Math.round(sequenceAware
            ? 1500 + totalHeight / 2 - row.localY + jitterY
            : 1500 - totalHeight / 2 + row.localY + jitterY),
        ],
        radius: item.radius,
        phase: item.phase,
      };
    }
  }
  return result;
}

function roleOf(point, rolesById) {
  const supplied = rolesById[point.id];
  if (supplied === "trunk" || supplied === "branch" || supplied === "leaf") return supplied;
  if ((point.importance ?? 0) >= 0.88) return "trunk";
  if ((point.importance ?? 0) >= 0.75) return "branch";
  return "leaf";
}

function makePolygon(anchor, memberCount, style, random) {
  const vertexCount = style.vertices[0] + Math.floor(random() * (style.vertices[1] - style.vertices[0] + 1));
  const memberAllowanceScale = style.pointGap / MAP_LAYOUT_STYLES.organic.pointGap;
  const radiusX = anchor.radius[0] + memberCount * 11 * memberAllowanceScale;
  const radiusY = anchor.radius[1] + memberCount * 9 * memberAllowanceScale;
  const polygon = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const angle = anchor.phase + (Math.PI * 2 * vertex) / vertexCount + (random() - 0.5) * 0.13;
    const radius = 0.83 + random() * 0.22;
    polygon.push([
      Math.round(anchor.center[0] + Math.cos(angle) * radiusX * radius),
      Math.round(anchor.center[1] + Math.sin(angle) * radiusY * radius),
    ]);
  }
  return { polygon, radiusX, radiusY };
}

/**
 * 纯函数：根据现有课程索引生成一套地图布局。调用者负责决定是否写回文件。
 */
export function createCourseMapLayout({ courseId, index, rolesById = {}, styleName = "organic", seed = courseId }) {
  const stylePreset = MAP_LAYOUT_STYLES[styleName];
  if (!stylePreset) fail(`未知布局风格：${styleName}；可用：${Object.keys(MAP_LAYOUT_STYLES).join("、")}`);
  if (!Array.isArray(index?.clusters) || !Array.isArray(index?.points)) fail("index.json 必须包含 clusters 与 points 数组");
  // Small and medium courses keep the generous spacing seen in the UI audit.
  // Very large maps reduce world-space gaps gradually so hundreds of points do
  // not expand the camera range without bound; the renderer still applies a
  // screen-space anti-overlap pass at every zoom level.
  const densityScale = Math.max(
    0.72,
    Math.min(1, Math.sqrt(140 / Math.max(140, index.points.length))),
  );
  const style = densityScale === 1
    ? stylePreset
    : {
        ...stylePreset,
        clusterJitter: stylePreset.clusterJitter * densityScale,
        clusterGap: stylePreset.clusterGap.map((gap) => Math.max(94, gap * densityScale)),
        pointGap: stylePreset.pointGap * densityScale,
      };

  const clusterIds = index.clusters.map((cluster) => cluster.id);
  const clusterSequenceEdges = sequenceEdges(clusterIds, index.sequences?.cluster);
  const clusterOrder = sequenceFirstOrder(clusterIds, clusterSequenceEdges);
  const clusterById = new Map(index.clusters.map((cluster) => [cluster.id, cluster]));
  const orderedClusters = clusterOrder.map((id) => clusterById.get(id)).filter(Boolean);
  const configuredAnchors = COURSE_ANCHORS[courseId];
  // A course may be regenerated with a different cluster taxonomy.  A stale
  // hand-tuned map must never make publication fail merely because the course
  // id is unchanged; only use it when it covers the complete current graph.
  const anchors = clusterSequenceEdges.length === 0 && configuredAnchors
    && index.clusters.every((cluster) => configuredAnchors[cluster.id])
    ? configuredAnchors
    : genericAnchors(
        orderedClusters,
        index.points,
        style,
        seed,
        clusterSequenceEdges.length > 0,
      );
  const clusterLayouts = new Map();
  const clusters = index.clusters.map((cluster) => {
    const anchor = anchors[cluster.id];
    if (!anchor) fail(`缺少知识簇 ${cluster.id} 的布局锚点`);
    const random = seededRandom(`${seed}:${cluster.id}:polygon`);
    const members = index.points.filter((point) => point.clusterId === cluster.id);
    const shape = makePolygon(anchor, members.length, style, random);
    clusterLayouts.set(cluster.id, { ...anchor, ...shape });
    return {
      ...cluster,
      polygon: shape.polygon,
      labelPos: [anchor.center[0], Math.round(anchor.center[1] - shape.radiusY * 0.42)],
    };
  });

  const roleRank = { trunk: 0, branch: 1, leaf: 2 };
  const layouts = new Map();
  for (const cluster of clusters) {
    const bounds = clusterLayouts.get(cluster.id);
    const fallbackMembers = index.points
      .filter((point) => point.clusterId === cluster.id)
      .sort((left, right) => roleRank[roleOf(left, rolesById)] - roleRank[roleOf(right, rolesById)] || left.id.localeCompare(right.id));
    const memberIds = fallbackMembers.map((point) => point.id);
    const memberById = new Map(fallbackMembers.map((point) => [point.id, point]));
    const pointSequenceEdges = sequenceEdges(memberIds, index.sequences?.point);
    const members = sequenceFirstOrder(memberIds, pointSequenceEdges)
      .map((id) => memberById.get(id))
      .filter(Boolean);
    const random = seededRandom(`${seed}:${cluster.id}:points`);
    const placed = [];
    const placedById = new Map();
    const placedSequenceSegments = [];
    for (const point of members) {
      const role = roleOf(point, rolesById);
      const scale = Math.round((style.scale[role] + ((point.importance ?? 0.5) - 0.5) * 0.22 + (random() - 0.5) * 0.08) * 100) / 100;
      let position = null;
      let fallbackPosition = null;
      let bestScore = Infinity;
      const connectedEdges = pointSequenceEdges.filter((edge) => (
        edge.fromId === point.id || edge.toId === point.id
      ));
      const maximumAttempts = pointSequenceEdges.length > 0 ? 1400 : 420;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const angle = random() * Math.PI * 2;
        const band = attempt < 320
          ? role === "trunk"
            ? 0.14 + random() * 0.28
            : role === "branch"
              ? 0.28 + random() * 0.43
              : 0.24 + Math.sqrt(random()) * (style.pointSpread - 0.24)
          : 0.18 + Math.sqrt(random()) * (style.pointSpread - 0.18);
        const candidate = [
          Math.round(bounds.center[0] + Math.cos(angle) * bounds.radiusX * band),
          Math.round(bounds.center[1] + Math.sin(angle) * bounds.radiusY * band),
        ];
        const minimumGap = attempt < 320 ? style.pointGap : style.pointGap * 0.9;
        const hasRoom = placed.every((other) => Math.hypot(candidate[0] - other.pos[0], candidate[1] - other.pos[1]) >= minimumGap * ((scale + other.scale) / 2));
        if (hasRoom && pointInPolygon(candidate, bounds.polygon)) {
          if (pointSequenceEdges.length === 0) {
            position = candidate;
            break;
          }

          fallbackPosition ??= candidate;
          const candidateSegments = connectedEdges.flatMap((edge) => {
            const otherId = edge.fromId === point.id ? edge.toId : edge.fromId;
            const other = placedById.get(otherId);
            if (!other) return [];
            return [{
              fromId: edge.fromId,
              toId: edge.toId,
              start: edge.fromId === point.id ? candidate : other.pos,
              end: edge.toId === point.id ? candidate : other.pos,
            }];
          });
          const crossesExistingPath = candidateSegments.some((candidateSegment) => (
            placedSequenceSegments.some((existingSegment) => {
              const sharesEndpoint = candidateSegment.fromId === existingSegment.fromId
                || candidateSegment.fromId === existingSegment.toId
                || candidateSegment.toId === existingSegment.fromId
                || candidateSegment.toId === existingSegment.toId;
              return !sharesEndpoint && segmentsCross(
                candidateSegment.start,
                candidateSegment.end,
                existingSegment.start,
                existingSegment.end,
              );
            })
          ));
          if (crossesExistingPath) continue;

          const connectedDistance = candidateSegments.reduce(
            (total, segment) => total + Math.hypot(
              segment.end[0] - segment.start[0],
              segment.end[1] - segment.start[1],
            ),
            0,
          );
          const centerDistance = Math.hypot(
            candidate[0] - bounds.center[0],
            candidate[1] - bounds.center[1],
          );
          // Once crossings are eliminated, prefer short readable links. The
          // small center term only breaks ties for a source or isolated node.
          const score = connectedDistance + centerDistance * 0.001;
          if (score < bestScore) {
            position = candidate;
            bestScore = score;
          }
        }
      }
      position ??= fallbackPosition;
      if (!position) fail(`无法为知识点 ${point.id} 生成无重叠布局`);
      const placement = { id: point.id, pos: position, scale };
      placed.push(placement);
      placedById.set(point.id, placement);
      for (const edge of connectedEdges) {
        const from = placedById.get(edge.fromId);
        const to = placedById.get(edge.toId);
        if (!from || !to) continue;
        placedSequenceSegments.push({
          ...edge,
          start: from.pos,
          end: to.pos,
        });
      }
      layouts.set(point.id, { pos: position, scale });
    }
  }

  return {
    index: {
      ...index,
      clusters,
      points: index.points.map((point) => ({ ...point, ...layouts.get(point.id) })),
    },
    layouts,
    stats: {
      style: styleName,
      seed,
      clusters: clusters.length,
      points: index.points.length,
      polygonVertices: clusters.map((cluster) => cluster.polygon.length),
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomically(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const [courseId] = args;
  if (!courseId || courseId.startsWith("-")) fail("用法：node scripts/layout-course-map.mjs <course-id> [--style organic|compact] [--seed value] [--apply]");
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    courseId,
    styleName: valueAfter("--style") ?? "organic",
    seed: valueAfter("--seed") ?? courseId,
    apply: args.includes("--apply"),
  };
}

function printHelp() {
  console.log(`课程地图布局工具

用法：node scripts/layout-course-map.mjs <course-id> [选项]

选项：
  --style <organic|compact>  空间分布风格，默认 organic
  --seed <value>             固定随机种子；同一输入与种子必得同一布局
  --apply                    写入 index.json 与 points/*.json；省略时仅预览
  --help, -h                 显示帮助
`);
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!ID_PATTERN.test(options.courseId)) fail("course-id 必须是小写 kebab-case");

  const resolvedCourseRoot = fs.realpathSync(courseRoot);
  const courseDirectory = path.resolve(courseRoot, options.courseId);
  if (path.dirname(courseDirectory) !== resolvedCourseRoot) fail("课程目录不在受控课程根目录中");
  if (!fs.existsSync(courseDirectory)) fail(`课程不存在：${options.courseId}`);

  const indexPath = path.join(courseDirectory, "index.json");
  const index = readJson(indexPath);
  const rolesById = {};
  const details = new Map();
  for (const point of index.points ?? []) {
    const detailPath = path.join(courseDirectory, "points", `${point.id}.json`);
    if (!fs.existsSync(detailPath)) fail(`缺少知识点详情文件：${point.id}`);
    const detail = readJson(detailPath);
    details.set(point.id, { path: detailPath, detail });
    rolesById[point.id] = detail.role;
  }

  const result = createCourseMapLayout({ ...options, index, rolesById });
  if (options.apply) {
    writeJsonAtomically(indexPath, result.index);
    for (const point of result.index.points) {
      const item = details.get(point.id);
      writeJsonAtomically(item.path, { ...item.detail, pos: point.pos, scale: point.scale });
    }
  }
  console.log(JSON.stringify({ ...result.stats, applied: options.apply }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(`课程地图布局失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
