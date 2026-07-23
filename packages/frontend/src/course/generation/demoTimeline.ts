import type { CourseMeta, ForestIndex } from "@/course/forest/types";
import type {
  GenerationPoint,
  GenerationTimeline,
  GenerationTimelineItem,
} from "./types";

const SEED_INTERVAL = 72;
const TREE_INTERVAL = 430;

export function buildDemoGenerationTimeline(
  course: CourseMeta,
  index: ForestIndex
): GenerationTimeline {
  const items: GenerationTimelineItem[] = [];
  const points: GenerationPoint[] = index.points.map((point, order) => ({
    id: point.id,
    title: point.title,
    clusterId: point.clusterId,
    importance: point.importance,
    pos: point.pos,
    scale: point.scale,
    order,
  }));

  items.push({
    at: 0,
    event: {
      type: "generation_started",
      course: {
        id: course.id,
        title: course.title,
        description: course.description,
      },
      totalPoints: points.length,
    },
  });
  items.push({
    at: 250,
    event: {
      type: "phase_changed",
      gate: "G0_SCOPE",
      label: "梳理课程范围",
      detail: "正在确定学习目标、受众和课程边界。",
    },
  });
  items.push({
    at: 1_750,
    event: {
      type: "phase_changed",
      gate: "G1_INDEX",
      label: "规划知识版图",
      detail: `正在识别 ${points.length} 个候选知识点。`,
    },
  });

  const seedStart = 2_250;
  points.forEach((point, index) => {
    items.push({
      at: seedStart + index * SEED_INTERVAL,
      event: { type: "point_planned", point },
    });
  });

  const reviewStart = seedStart + points.length * SEED_INTERVAL + 700;
  items.push({
    at: reviewStart,
    event: {
      type: "phase_changed",
      gate: "G2_IDENTITY_REVIEW",
      label: "复核知识点身份",
      detail: "检查重名、粒度和课程边界，冻结知识点目录。",
    },
  });

  const contentStart = reviewStart + 1_250;
  items.push({
    at: contentStart,
    event: {
      type: "phase_changed",
      gate: "G3_CONTENT",
      label: "编写课程内容",
      detail: "每完成一个知识点，就让一棵树在森林里长出来。",
    },
  });

  const treeStart = contentStart + 650;
  points.forEach((point, index) => {
    items.push({
      at: treeStart + index * TREE_INTERVAL,
      event: { type: "point_grown", pointId: point.id },
    });
  });

  const animationStart = treeStart + points.length * TREE_INTERVAL + 950;
  items.push({
    at: animationStart,
    event: {
      type: "phase_changed",
      gate: "G4_ANIMATIONS",
      label: "设计教学动画",
      detail: "识别适合动态讲解的机制，并准备交互教学素材。",
    },
  });

  const readyStart = animationStart + 2_300;
  items.push({
    at: readyStart,
    event: {
      type: "phase_changed",
      gate: "G5_CONTENT_READY",
      label: "校验课程内容",
      detail: "正在检查完整性、前置知识和内容一致性。",
    },
  });

  const graphStart = readyStart + 2_250;
  items.push({
    at: graphStart,
    event: {
      type: "phase_changed",
      gate: "G6_GRAPH",
      label: "形成知识森林",
      detail: "树木正在聚成知识簇，并建立学习路径。",
    },
  });
  items.push({
    at: graphStart + 800,
    event: {
      type: "clusters_ready",
      clusters: index.clusters,
    },
  });

  const releaseStart = graphStart + 5_200;
  items.push({
    at: releaseStart,
    event: {
      type: "phase_changed",
      gate: "G7_RELEASE_READY",
      label: "发布前最终检查",
      detail: "确认课程包、知识图谱与森林布局可以正式发布。",
    },
  });
  items.push({
    at: releaseStart + 2_300,
    event: {
      type: "generation_completed",
      courseId: course.id,
    },
  });

  return {
    duration: releaseStart + 2_300,
    items: items.sort((left, right) => left.at - right.at),
  };
}

