import teacherAiEcosystemImage from "../../assets/course-catalog/teacher-ai-ecosystem.png";

export type CourseGroupCanvasImage = {
  id: string;
  kind: "image";
  src: string;
  alt: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked: true;
};

type CanvasBounds = {
  width: number;
  height: number;
};

type ResponsiveCanvasOptions = {
  availableWidth: number;
  compact: boolean;
  nodePositions: Iterable<{ x: number; y: number }>;
};

export const CASE_COURSE_GROUP_ID = "group-ab7bd096f6";

const CASE_CANVAS_ELEMENTS: readonly CourseGroupCanvasImage[] = [
  {
    id: "teacher-ai-ecosystem-overview",
    kind: "image",
    src: teacherAiEcosystemImage,
    alt: "教师智能素养能力图谱、题库与知识图谱关系示意图",
    description: "岗位描述形成能力项，能力项与测试题相互评价，测试题关联并要求知识主题，知识主题由教学资源支撑。",
    x: 280,
    y: 110,
    width: 821,
    height: 283,
    locked: true,
  },
];

const EMPTY_CANVAS_ELEMENTS: readonly CourseGroupCanvasImage[] = [];

export function courseGroupCanvasElements(groupId: string | undefined): readonly CourseGroupCanvasImage[] {
  return groupId === CASE_COURSE_GROUP_ID ? CASE_CANVAS_ELEMENTS : EMPTY_CANVAS_ELEMENTS;
}

export function positionCanvasElements(
  elements: readonly CourseGroupCanvasImage[],
  options: ResponsiveCanvasOptions,
): readonly CourseGroupCanvasImage[] {
  const needsHorizontalFit = elements.some(
    (element) => element.x + element.width + 36 > options.availableWidth,
  );
  if ((!options.compact && !needsHorizontalFit) || elements.length === 0) return elements;
  const nodeBottom = Math.max(0, ...[...options.nodePositions].map((position) => position.y + 24));
  return elements.map((element) => {
    const width = Math.min(element.width, Math.max(240, options.availableWidth - 56));
    const scale = width / element.width;
    return {
      ...element,
      x: Math.max(28, (options.availableWidth - width) / 2),
      y: Math.max(element.y, nodeBottom + 24),
      width,
      height: element.height * scale,
    };
  });
}

export function extendCanvasBounds(
  bounds: CanvasBounds,
  elements: readonly CourseGroupCanvasImage[],
  horizontalPadding = 36,
  controlAreaReserve = 96,
): CanvasBounds {
  return elements.reduce(
    (current, element) => ({
      width: Math.max(current.width, element.x + element.width + horizontalPadding),
      height: Math.max(current.height, element.y + element.height + controlAreaReserve),
    }),
    { ...bounds },
  );
}
