export type ForestPoint = {
  id: string;
  title: string;
  clusterId: string;
  /** Where this point entered a textbook-grounded course. */
  origin?: "textbook" | "llm-extension" | "user";
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

/** A directed reading-order edge. It is intentionally separate from prerequisite relations. */
export type ForestSequenceEdge = {
  fromId: string;
  toId: string;
};

export type ForestSequences = {
  /** Recommended order between knowledge clusters. */
  cluster: ForestSequenceEdge[];
  /** Recommended order between knowledge points. */
  point: ForestSequenceEdge[];
};

export type ForestSourceSpan = {
  materialId: string;
  blockIds: string[];
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  page?: number;
  assetRefs: string[];
  excerptSha256: string;
};

export const TEXTBOOK_CONTENT_V2_SCHEMA = "textbook-content/2.0" as const;

export type TextbookContentBlockKind =
  | "definition"
  | "explanation"
  | "mechanism"
  | "procedure"
  | "formula"
  | "example"
  | "worked-example"
  | "comparison"
  | "application"
  | "code"
  | "table"
  | "figure"
  | "warning"
  | "misconception"
  | "exercise"
  | "summary"
  | "note"
  | "other";

/** A block grounded directly in one or more locations in the bound textbook. */
export type TextbookContentTextbookProvenance = {
  origin: "textbook";
  representation: "quote" | "paraphrase";
  sourceSpans: ForestSourceSpan[];
};

/** Model-authored teaching material that expands earlier blocks in this point. */
export type TextbookContentModelProvenance = {
  origin: "model";
  basedOnBlockIds: string[];
  sourceSpans?: ForestSourceSpan[];
};

export type TextbookContentBlockProvenance =
  | TextbookContentTextbookProvenance
  | TextbookContentModelProvenance;

export type TextbookLearningDepth = "core" | "support" | "advanced";

export type TextbookLearningOutcome = {
  id?: string;
  text: string;
};

export type TextbookLearningModule = {
  id: string;
  title: string;
  role?: string;
  description?: string;
  /** Learning outcomes served by this module in the canonical teaching plan. */
  outcomeRefs?: string[];
  /** Explicit module order; array order remains the legacy fallback. */
  order?: number;
};

export type TextbookLearningCompletion = {
  outcomeRefs?: string[];
  method?: string;
  successCriteria?: string[];
  exerciseBlockId?: string;
  summaryBlockId?: string;
  nextPointId?: string;
};

export type TextbookLearningDesign = {
  primaryPattern?: string;
  /** Editorial intensity: source-faithful, balanced, or teaching-first. */
  adaptationLevel?: "faithful" | "balanced" | "teaching-first";
  /** Short learner-facing explanation of how the textbook was reorganized. */
  editorialPolicy?: string;
  estimatedMinutes?: number;
  outcomes?: TextbookLearningOutcome[];
  misconceptions?: string[];
  modules?: TextbookLearningModule[];
  completion?: TextbookLearningCompletion;
};

export type TextbookLearningAssetFallback = {
  type?: string;
  mode?: string;
  markdown?: string;
  caption?: string;
  content?: string;
  blockId?: string;
};

export type TextbookLearningAssetConfig = Record<string, unknown> & {
  preset?: string | Record<string, unknown>;
  controls?: string[] | Record<string, unknown>;
  outputs?: string[] | Record<string, unknown>;
};

export type TextbookLearningAssetGrounding = {
  basedOnBlockIds: string[];
};

export type TextbookLearningAsset = {
  id: string;
  type: string;
  anchorBlockId: string;
  title?: string;
  animationType?: string;
  learningPurpose?: string;
  caption?: string;
  moduleId?: string;
  depth?: TextbookLearningDepth;
  outcomeRefs?: string[];
  config?: TextbookLearningAssetConfig;
  grounding?: TextbookLearningAssetGrounding;
  fallback?: TextbookLearningAssetFallback;
};

export type TextbookContentBlock = {
  id: string;
  kind: TextbookContentBlockKind;
  title?: string;
  markdown: string;
  provenance: TextbookContentBlockProvenance;
  /** Optional teaching module used by the learner-facing reading outline. */
  moduleId?: string;
  /** Learning importance is separate from textbook/model authorship. */
  depth?: TextbookLearningDepth;
};

/** Ordered, provenance-aware teaching content used by textbook-grounded courses. */
export type TextbookPointContentV2 = {
  schema_version: typeof TEXTBOOK_CONTENT_V2_SCHEMA;
  blocks: TextbookContentBlock[];
  /** Forward-compatible teaching metadata; v2 payloads may omit it. */
  learningDesign?: TextbookLearningDesign;
  /** Assets are rendered immediately after their anchor block when possible. */
  learningAssets?: TextbookLearningAsset[];
};

export type ForestIndex = {
  clusters: ForestCluster[];
  points: ForestPoint[];
  /** Optional for backward compatibility with courses published before sequence support. */
  sequences?: ForestSequences;
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
  subtitle?: string;
  kind?: string;
  role?: string;
  coreIdea?: string;
  principles?: string[];
  applications?: string[];
  comparisons?: string[];
  formula?: string;
  aliases?: string[];
  related?: string[];
  intuition?: string;
  misconceptions?: string[];
  history?: string;
  prerequisites?: string[];
  visualType?: string;
  animationType?: string;
  visualSuggestion?: string;
  animationSuggestion?: string;
  /** Optional teaching metadata may live beside content during the v2-to-v3 transition. */
  learningDesign?: TextbookLearningDesign;
  learningAssets?: TextbookLearningAsset[];
  /** Verifiable textbook excerpts used to ground this point's content. */
  sourceSpans?: ForestSourceSpan[];
  /** True when the point includes model-authored enrichment beyond its source excerpts. */
  modelEnriched?: boolean;
  yearIntroduced?: number;
  visual?: {
    type?: string;
    caption?: string;
    color?: string;
  };
  ideologicalElement?: string;
  prosCons?: {
    pros?: string[];
    cons?: string[];
  };
  qa?: Array<{
    q: string;
    a: string;
  }>;
  /** Present on provenance-aware textbook courses. Legacy fields remain readable. */
  content?: TextbookPointContentV2;
};

export type CourseDataChangedDetail = {
  course_id?: string;
  revision?: string;
  changed_paths?: string[];
};
