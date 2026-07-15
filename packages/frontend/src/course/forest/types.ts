export type ForestPoint = {
  id: string;
  title: string;
  clusterId: string;
  shortSummary?: string;
  difficulty?: string;
  importance?: number;
  keyTerms?: string[];
  pos: [number, number];
  scale?: number;
};

export type ForestCluster = {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  accent: string;
  soft?: string;
  dark?: string;
  polygon?: [number, number][];
  labelPos?: [number, number];
};

export type ForestIndex = {
  clusters: ForestCluster[];
  points: ForestPoint[];
};

/** Metadata exposed by the course catalog API and shared by all course views. */
export type CourseMeta = {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  language?: string;
  revision?: string | number;
  clusters?: number;
  points?: number;
};

export type CoursePointDetail = ForestPoint & {
  coreIdea?: string;
  principles?: string[];
  applications?: string[];
  comparisons?: string[];
  formula?: string;
  aliases?: string[];
  intuition?: string;
  misconceptions?: string[];
  history?: string;
  prerequisites?: string[];
  visualType?: string;
  animationType?: string;
  visualSuggestion?: string;
  animationSuggestion?: string;
  ideologicalElement?: string;
  prosCons?: {
    pros?: string[];
    cons?: string[];
  };
  qa?: Array<{
    q: string;
    a: string;
  }>;
};

export type CourseDataChangedDetail = {
  course_id?: string;
  revision?: string;
  changed_paths?: string[];
};
