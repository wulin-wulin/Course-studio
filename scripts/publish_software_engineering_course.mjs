import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourcePath = path.join(projectRoot, "data", "clustered-graph.json");
const courseRoot = path.join(projectRoot, "course-data", "courses");
const targetDirectory = path.join(courseRoot, "software-engineering");
const overwrite = process.argv.includes("--overwrite");

const palette = [
  ["#2F7A65", "#E2F4EC", "#185342"],
  ["#7A5A2F", "#F7EEDC", "#573C1A"],
  ["#3D6E9C", "#E4F0FA", "#234766"],
  ["#7C4E8C", "#F3E8F7", "#563063"],
  ["#A15D37", "#FAEADF", "#71391F"],
  ["#A64252", "#F9E5E8", "#762634"],
  ["#497A55", "#E7F3E9", "#2D5936"],
  ["#4B6E72", "#E5F1F1", "#2C4D50"],
  ["#8B6A32", "#F7EFD9", "#654A1E"],
  ["#315F87", "#E3EFF8", "#1F425F"],
  ["#9A475E", "#F8E5EA", "#6B293B"],
  ["#665B8A", "#EDEAF7", "#453A65"],
];

const clusterTeaching = {
  "se-fundamentals": {
    principle: "从软件产品、工程活动、人员协作和交付约束四个角度建立共同语言",
    application: "为项目启动、过程选择和工程规范制定提供判断依据",
  },
  "process-models": {
    principle: "根据需求稳定性、技术风险、反馈速度和团队协作方式选择与调整过程",
    application: "帮助团队把开发活动组织为可计划、可反馈、可改进的迭代",
  },
  requirements: {
    principle: "持续澄清干系人目标，并把目标转化为可验证、可管理的需求基线",
    application: "用于产品发现、范围控制、验收约定和后续设计测试的共同依据",
  },
  "software-design": {
    principle: "在功能、质量属性、演化成本和团队认知负担之间作出可解释的设计取舍",
    application: "指导系统分解、接口定义、交互设计和架构决策记录",
  },
  "software-construction": {
    principle: "通过清晰的代码结构、自动化反馈和可复用构件把设计可靠地实现为产品",
    application: "改善日常编码、代码审查、集成和演化时的可维护性",
  },
  "software-testing": {
    principle: "以风险为导向设计测试，并用不同层级和技术建立可重复的质量反馈",
    application: "用于缺陷预防、持续验证、发布把关和回归风险控制",
  },
  "quality-and-maintenance": {
    principle: "用可度量的质量目标和反馈闭环管理产品演化，而不是只在交付前集中检查",
    application: "支撑质量改进、技术债治理、维护决策和长期可靠运行",
  },
  "configuration-management": {
    principle: "识别配置项、记录版本和变更，并让可追溯性贯穿构建、审计和发布",
    application: "减少多人协作中的版本冲突、不可复现构建和变更失控",
  },
  "project-management": {
    principle: "把范围、进度、成本、风险和人员协作置于同一套透明的决策框架中",
    application: "用于项目计划、资源协调、风险应对和干系人沟通",
  },
  devops: {
    principle: "打通开发、交付与运行反馈，使变更能够以小批量、可观测、可恢复的方式流动",
    application: "用于自动化流水线、稳定发布、运行响应和持续改进",
  },
  "software-security": {
    principle: "把安全目标、威胁分析和控制措施前移到生命周期的每个关键决策中",
    application: "用于降低漏洞、数据泄露和业务中断带来的工程风险",
  },
  "boundary-topics": {
    principle: "在课程基础方法之上理解严谨性、协作方式与工程边界的扩展选择",
    application: "为进一步学习高可信系统和开放协作实践建立入口",
  },
};

// 课程簇的全局落点刻意错开，模拟原《人工智能原理》知识森林的岛屿式分布，
// 而不是按行列平铺。半径会随该簇的知识点数量进一步扩展。
const clusterAnchors = {
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
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function randomFor(seed) {
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

function displayList(values, limit = 3) {
  const selected = values.filter(Boolean).slice(0, limit);
  if (selected.length === 0) return "目标、约束与反馈";
  return selected.join("、");
}

function layoutClusters(clusters, points) {
  return clusters.map((cluster, index) => {
    const anchor = clusterAnchors[cluster.id];
    assert(anchor, `缺少知识簇 ${cluster.id} 的布局锚点`);
    const memberCount = points.filter((point) => point.clusterId === cluster.id).length;
    const random = randomFor(`${cluster.id}:polygon`);
    const vertexCount = 5 + Math.floor(random() * 5);
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
    const [accent, soft, dark] = palette[index % palette.length];
    return {
      ...cluster,
      accent,
      soft,
      dark,
      polygon,
      labelPos: [anchor.center[0], anchor.center[1] - radiusY * 0.22],
      _bounds: { center: anchor.center, radiusX, radiusY },
    };
  });
}

function layoutPoints(points, clusterLayouts) {
  const clusterById = new Map(clusterLayouts.map((cluster) => [cluster.id, cluster]));
  const roleRank = { trunk: 0, branch: 1, leaf: 2 };
  const layouts = new Map();

  for (const cluster of clusterLayouts) {
    const members = points
      .filter((point) => point.clusterId === cluster.id)
      .sort((left, right) => (roleRank[left.role] ?? 3) - (roleRank[right.role] ?? 3) || left.title.localeCompare(right.title, "zh-CN"));
    const random = randomFor(`${cluster.id}:points`);
    const placed = [];
    for (let index = 0; index < members.length; index += 1) {
      const point = members[index];
      const baseScale = point.role === "trunk" ? 1.16 : point.role === "branch" ? 0.86 : 0.6;
      const scale = Math.round((baseScale + (point.importance - 0.5) * 0.22 + (random() - 0.5) * 0.08) * 100) / 100;
      let selected = null;
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const angle = random() * Math.PI * 2;
        const band = point.role === "trunk"
          ? 0.14 + random() * 0.28
          : point.role === "branch"
            ? 0.28 + random() * 0.43
            : 0.24 + Math.sqrt(random()) * 0.62;
        const candidate = [
          Math.round(cluster._bounds.center[0] + Math.cos(angle) * cluster._bounds.radiusX * band),
          Math.round(cluster._bounds.center[1] + Math.sin(angle) * cluster._bounds.radiusY * band),
        ];
        const minDistanceFactor = attempt < 180 ? 98 : 78;
        const hasRoom = placed.every((other) => {
          const distance = Math.hypot(candidate[0] - other.pos[0], candidate[1] - other.pos[1]);
          return distance >= minDistanceFactor * ((scale + other.scale) / 2);
        });
        if (hasRoom && pointInPolygon(candidate, cluster.polygon)) {
          selected = candidate;
          break;
        }
      }
      assert(selected, `无法为知识点 ${point.id} 生成无重叠布局`);
      placed.push({ pos: selected, scale });
      layouts.set(point.id, {
        pos: selected,
        scale,
      });
    }
  }

  assert(layouts.size === points.length, "部分知识点未生成森林布局");
  return layouts;
}

function relatedTitles(point, pointById) {
  return (point.related ?? []).map((id) => pointById.get(id)?.title).filter(Boolean);
}

function prerequisiteTitles(point, pointById) {
  return (point.prerequisites ?? []).map((id) => pointById.get(id)?.title).filter(Boolean);
}

function makeDetail(point, pointById, clusterById, pointLayouts) {
  const cluster = clusterById.get(point.clusterId);
  const teaching = clusterTeaching[point.clusterId];
  const terms = point.keyTerms ?? [];
  const prerequisites = prerequisiteTitles(point, pointById);
  const related = relatedTitles(point, pointById);
  const { pos, scale } = pointLayouts.get(point.id);
  const firstTerm = terms[0] ?? "工程目标";
  const secondTerm = terms[1] ?? "质量约束";
  const relationshipSentence = prerequisites.length
    ? `学习时先掌握${displayList(prerequisites, 2)}，再将本知识点用于更具体的工程决策。`
    : "它是理解后续软件工程活动的起点，应先建立问题、约束和反馈之间的整体视角。";

  return {
    id: point.id,
    title: point.title,
    clusterId: point.clusterId,
    shortSummary: point.shortSummary,
    coreIdea: `${point.shortSummary} 学习${point.title}的关键，不是孤立记忆术语，而是理解它如何在真实项目中把目标、约束与反馈连接起来。`,
    principles: [
      `${teaching.principle}。`,
      `围绕${displayList(terms)}等要素明确输入、活动、产出和评价标准，避免只停留在概念名称上。`,
      relationshipSentence,
    ],
    keyTerms: terms,
    aliases: point.aliases ?? [],
    kind: point.kind,
    role: point.role,
    prerequisites: point.prerequisites ?? [],
    related: point.related ?? [],
    comparisons: related.length
      ? related.slice(0, 3).map((title) => `${point.title}与${title}相互关联，但应分别关注各自解决的工程问题与适用边界。`)
      : [`${point.title}应结合所在知识簇的其他主题理解，不能脱离项目上下文机械套用。`],
    applications: [
      `${teaching.application}。`,
      `在团队协作中，可围绕${firstTerm}和${secondTerm}形成可讨论、可审查的工作产物。`,
      "通过复盘实际案例，根据结果调整实践方式，而不是把一次性的流程选择当成固定答案。",
    ],
    intuition: `把${point.title}看作软件工程中的一个“决策支点”：它帮助团队在不确定条件下说明为什么这样做、如何检查结果以及出现偏差后怎样调整。`,
    misconceptions: [
      `${point.title}不是可以脱离业务目标和团队条件直接照搬的固定步骤。`,
      "只完成文档、工具或仪式本身并不等于达成工程目标；还需观察质量、交付和协作反馈。",
    ],
    qa: [
      {
        q: `在项目中学习和使用${point.title}时，应先问什么问题？`,
        a: `先明确它要解决的风险或质量问题、参与者和可验证产出，再结合${displayList(terms, 2)}设计可执行的活动与反馈机制。`,
      },
    ],
    visualType: point.kind === "model" ? "model" : point.kind === "metric" ? "metric" : "process",
    visualSuggestion: `以“输入 → ${point.title} → 可验证产出”的流程图呈现，并在两侧标注${displayList(prerequisites, 2)}与${displayList(related, 2)}的关系。`,
    difficulty: point.difficulty,
    importance: point.importance,
    pos,
    scale,
  };
}

function publish() {
  assert(fs.existsSync(sourcePath), `找不到预备图谱：${sourcePath}`);
  const resolvedCourseRoot = fs.realpathSync(courseRoot);
  const resolvedTarget = path.resolve(targetDirectory);
  assert(path.dirname(resolvedTarget) === resolvedCourseRoot, "目标课程目录不在受控课程根目录中");
  if (fs.existsSync(targetDirectory)) {
    assert(overwrite, `目标课程已存在，拒绝覆盖：${targetDirectory}`);
    fs.rmSync(targetDirectory, { recursive: true, force: true });
  }

  const graph = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  assert(graph.schema_version === "clustered-graph/1.0", "预备图谱 schema_version 不正确");
  assert(Array.isArray(graph.clusters) && Array.isArray(graph.points), "预备图谱缺少 clusters 或 points");
  assert(graph.subject?.id === "software-engineering", "预备图谱课程 ID 不正确");

  const clusterLayouts = layoutClusters(graph.clusters, graph.points);
  const clusterById = new Map(clusterLayouts.map((cluster) => [cluster.id, cluster]));
  const pointById = new Map(graph.points.map((point) => [point.id, point]));
  const pointLayouts = layoutPoints(graph.points, clusterLayouts);
  const roleRank = { trunk: 0, branch: 1, leaf: 2 };
  const orderedPoints = clusterLayouts.flatMap((cluster) =>
    graph.points
      .filter((point) => point.clusterId === cluster.id)
      .sort((left, right) => (roleRank[left.role] ?? 3) - (roleRank[right.role] ?? 3) || left.title.localeCompare(right.title, "zh-CN"))
  );

  const course = {
    schema_version: "1.0",
    id: "software-engineering",
    title: graph.subject.normalizedTitle,
    subtitle: "软件工程知识森林",
    description: "面向本科软件工程课程的交互式知识森林，覆盖软件过程、需求、设计、构造、测试、质量、项目管理与运维。",
    language: graph.subject.language,
    revision: 1,
  };
  const index = {
    schema_version: "1.0",
    courseId: course.id,
    clusters: clusterLayouts.map(({ _bounds, order, ...cluster }) => cluster),
    points: orderedPoints.map((point) => {
      const { pos, scale } = pointLayouts.get(point.id);
      return {
        id: point.id,
        title: point.title,
        clusterId: point.clusterId,
        shortSummary: point.shortSummary,
        difficulty: point.difficulty,
        importance: point.importance,
        keyTerms: point.keyTerms,
        pos,
        scale,
      };
    }),
  };

  writeJson(path.join(targetDirectory, "course.json"), course);
  writeJson(path.join(targetDirectory, "index.json"), index);
  for (const point of orderedPoints) {
    writeJson(
      path.join(targetDirectory, "points", `${point.id}.json`),
      makeDetail(point, pointById, clusterById, pointLayouts)
    );
  }

  console.log(`已发布 ${course.id}：${index.clusters.length} 个知识簇，${index.points.length} 个知识点。`);
}

publish();
