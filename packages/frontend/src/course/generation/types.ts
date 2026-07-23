import type { ForestCluster, ForestPoint } from "@/course/forest/types";

export const GENERATION_GATES = [
  "G0_SCOPE",
  "G1_INDEX",
  "G2_IDENTITY_REVIEW",
  "G3_CONTENT",
  "G4_ANIMATIONS",
  "G5_CONTENT_READY",
  "G6_GRAPH",
  "G7_RELEASE_READY",
] as const;

export type GenerationGate = (typeof GENERATION_GATES)[number];

export type GenerationPoint = Pick<
  ForestPoint,
  "id" | "title" | "clusterId" | "importance" | "pos" | "scale"
> & {
  order: number;
};

export type GenerationPointStatus =
  | "planned"
  | "generating"
  | "grown"
  | "clustered";

export type GenerationPointState = GenerationPoint & {
  status: GenerationPointStatus;
  /** Estimated only. The backend reports completion, not token-level progress. */
  progress?: number;
  progressStartedAt?: number;
};

export type GenerationCourse = {
  id: string;
  title: string;
  description?: string;
};

export type CourseGenerationEvent =
  | {
      type: "generation_started";
      course: GenerationCourse;
      totalPoints: number;
    }
  | {
      type: "phase_changed";
      gate: GenerationGate;
      label: string;
      detail: string;
    }
  | {
      type: "point_planned";
      point: GenerationPoint;
    }
  | {
      type: "point_grown";
      pointId: string;
    }
  | {
      type: "clusters_ready";
      clusters: ForestCluster[];
    }
  | {
      type: "generation_completed";
      courseId: string;
    }
  | {
      type: "generation_failed";
      message: string;
    };

export type GenerationTimelineItem = {
  at: number;
  event: CourseGenerationEvent;
};

export type GenerationTimeline = {
  duration: number;
  items: GenerationTimelineItem[];
};

export type GenerationRunStatus =
  | "idle"
  | "requested"
  | "loading"
  | "running"
  | "paused"
  | "completed"
  | "error";

export type CourseGenerationSnapshotPoint = {
  id: string;
  title: string;
  order: number;
  importance?: number;
  complete: boolean;
  clusterId?: string;
};

export type CourseGenerationSnapshotCluster = {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  order?: number;
};

/**
 * Full, replay-safe state emitted by the backend while a course-create
 * conversation advances through the G0-G7 pipeline.
 */
export type CourseGenerationSnapshot = {
  conversation_id: string;
  gate: "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
  course: GenerationCourse | null;
  total_points: number;
  points: CourseGenerationSnapshotPoint[];
  clusters: CourseGenerationSnapshotCluster[];
  published: boolean;
};

export type LiveCourseGenerationRun = {
  conversationId: string;
  status: Exclude<GenerationRunStatus, "idle" | "requested" | "loading" | "paused">;
  course: GenerationCourse | null;
  gate: GenerationGate;
  phaseLabel: string;
  phaseDetail: string;
  totalPoints: number;
  points: GenerationPointState[];
  clusters: ForestCluster[];
  published: boolean;
  publishedCourseId: string | null;
  error: string | null;
  updatedAt: number;
  snapshotKey: string;
};

