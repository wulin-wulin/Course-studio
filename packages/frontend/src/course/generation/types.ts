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

export type GenerationPointStatus = "planned" | "grown" | "clustered";

export type GenerationPointState = GenerationPoint & {
  status: GenerationPointStatus;
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

