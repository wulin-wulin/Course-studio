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
    clusterJitter: 130,
    pointSpread: 0.86,
    pointGap: 98,
    scale: { trunk: 1.16, branch: 0.86, leaf: 0.6 },
  },
  compact: {
    description: "更紧凑的岛屿分布，适合知识簇较少或需要快速总览的课程",
    vertices: [5, 7],
    clusterJitter: 70,
    pointSpread: 0.7,
    pointGap: 84,
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

function genericAnchors(clusters, style, seed) {
  const random = seededRandom(`${seed}:anchors`);
  const columns = Math.max(2, Math.ceil(Math.sqrt((clusters.length * 4) / 3)));
  const rows = Math.ceil(clusters.length / columns);
  const xGap = columns === 1 ? 0 : 2900 / (columns - 1);
  const yGap = rows === 1 ? 0 : 2000 / (rows - 1);

  return Object.fromEntries(clusters.map((cluster, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const jitterX = (random() - 0.5) * style.clusterJitter;
    const jitterY = (random() - 0.5) * style.clusterJitter;
    return [cluster.id, {
      center: [Math.round(520 + column * xGap + jitterX), Math.round(480 + row * yGap + jitterY)],
      radius: [265 + random() * 95, 220 + random() * 75],
      phase: random() * Math.PI * 2,
    }];
  }));
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
  const radiusX = anchor.radius[0] + memberCount * 11;
  const radiusY = anchor.radius[1] + memberCount * 9;
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
  const style = MAP_LAYOUT_STYLES[styleName];
  if (!style) fail(`未知布局风格：${styleName}；可用：${Object.keys(MAP_LAYOUT_STYLES).join("、")}`);
  if (!Array.isArray(index?.clusters) || !Array.isArray(index?.points)) fail("index.json 必须包含 clusters 与 points 数组");

  const configuredAnchors = COURSE_ANCHORS[courseId];
  // A course may be regenerated with a different cluster taxonomy.  A stale
  // hand-tuned map must never make publication fail merely because the course
  // id is unchanged; only use it when it covers the complete current graph.
  const anchors = configuredAnchors
    && index.clusters.every((cluster) => configuredAnchors[cluster.id])
    ? configuredAnchors
    : genericAnchors(index.clusters, style, seed);
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
      labelPos: [anchor.center[0], Math.round(anchor.center[1] - shape.radiusY * 0.22)],
    };
  });

  const roleRank = { trunk: 0, branch: 1, leaf: 2 };
  const layouts = new Map();
  for (const cluster of clusters) {
    const bounds = clusterLayouts.get(cluster.id);
    const members = index.points
      .filter((point) => point.clusterId === cluster.id)
      .sort((left, right) => roleRank[roleOf(left, rolesById)] - roleRank[roleOf(right, rolesById)] || left.id.localeCompare(right.id));
    const random = seededRandom(`${seed}:${cluster.id}:points`);
    const placed = [];
    for (const point of members) {
      const role = roleOf(point, rolesById);
      const scale = Math.round((style.scale[role] + ((point.importance ?? 0.5) - 0.5) * 0.22 + (random() - 0.5) * 0.08) * 100) / 100;
      let position = null;
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const angle = random() * Math.PI * 2;
        const band = role === "trunk"
          ? 0.14 + random() * 0.28
          : role === "branch"
            ? 0.28 + random() * 0.43
            : 0.24 + Math.sqrt(random()) * (style.pointSpread - 0.24);
        const candidate = [
          Math.round(bounds.center[0] + Math.cos(angle) * bounds.radiusX * band),
          Math.round(bounds.center[1] + Math.sin(angle) * bounds.radiusY * band),
        ];
        const minimumGap = (attempt < 180 ? style.pointGap : style.pointGap * 0.8);
        const hasRoom = placed.every((other) => Math.hypot(candidate[0] - other.pos[0], candidate[1] - other.pos[1]) >= minimumGap * ((scale + other.scale) / 2));
        if (hasRoom && pointInPolygon(candidate, bounds.polygon)) {
          position = candidate;
          break;
        }
      }
      if (!position) fail(`无法为知识点 ${point.id} 生成无重叠布局`);
      placed.push({ pos: position, scale });
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
