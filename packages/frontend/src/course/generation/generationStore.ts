import { create } from "zustand";
import type { ForestCluster } from "@/course/forest/types";
import type {
  CourseGenerationEvent,
  GenerationCourse,
  GenerationGate,
  GenerationPointState,
  GenerationRunStatus,
} from "./types";

type CourseGenerationState = {
  status: GenerationRunStatus;
  mode: "demo" | "live";
  course: GenerationCourse | null;
  gate: GenerationGate | null;
  phaseLabel: string;
  phaseDetail: string;
  totalPoints: number;
  points: GenerationPointState[];
  clusters: ForestCluster[];
  speed: number;
  error: string | null;
  requestDemo: () => void;
  markLoading: () => void;
  applyEvent: (event: CourseGenerationEvent) => void;
  setPaused: (paused: boolean) => void;
  setSpeed: (speed: number) => void;
  reset: () => void;
};

const INITIAL_STATE = {
  status: "idle" as const,
  mode: "demo" as const,
  course: null,
  gate: null,
  phaseLabel: "",
  phaseDetail: "",
  totalPoints: 0,
  points: [],
  clusters: [],
  speed: 1,
  error: null,
};

export const useCourseGenerationStore = create<CourseGenerationState>((set) => ({
  ...INITIAL_STATE,

  requestDemo: () => {
    set((state) => {
      if (state.status !== "idle" && state.status !== "error") return state;
      return {
        ...INITIAL_STATE,
        status: "requested",
        mode: "demo",
      };
    });
  },

  markLoading: () => {
    set((state) => ({
      ...state,
      status: "loading",
      error: null,
    }));
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "generation_started":
        set((state) => ({
          ...INITIAL_STATE,
          status: "running",
          mode: state.mode,
          speed: state.speed,
          course: event.course,
          totalPoints: event.totalPoints,
        }));
        return;

      case "phase_changed":
        set((state) => ({
          ...state,
          status: state.status === "paused" ? "paused" : "running",
          gate: event.gate,
          phaseLabel: event.label,
          phaseDetail: event.detail,
          error: null,
        }));
        return;

      case "point_planned":
        set((state) => {
          const existing = state.points.findIndex((point) => point.id === event.point.id);
          const nextPoint: GenerationPointState = {
            ...event.point,
            status: "planned",
          };
          if (existing < 0) {
            return { ...state, points: [...state.points, nextPoint] };
          }
          const points = [...state.points];
          points[existing] = { ...points[existing], ...nextPoint };
          return { ...state, points };
        });
        return;

      case "point_grown":
        set((state) => ({
          ...state,
          points: state.points.map((point) =>
            point.id === event.pointId ? { ...point, status: "grown" } : point
          ),
        }));
        return;

      case "clusters_ready":
        set((state) => ({
          ...state,
          clusters: event.clusters,
          points: state.points.map((point) => ({ ...point, status: "clustered" })),
        }));
        return;

      case "generation_completed":
        set((state) => ({
          ...state,
          status: "completed",
          gate: "G7_RELEASE_READY",
          phaseLabel: "课程发布完成",
          phaseDetail: "知识点、知识簇和学习路径已经汇成完整森林。",
          points: state.points.map((point) => ({ ...point, status: "clustered" })),
        }));
        return;

      case "generation_failed":
        set((state) => ({
          ...state,
          status: "error",
          error: event.message,
        }));
    }
  },

  setPaused: (paused) => {
    set((state) => {
      if (state.status === "completed" || state.status === "error") return state;
      return {
        ...state,
        status: paused ? "paused" : "running",
      };
    });
  },

  setSpeed: (speed) => {
    set((state) => ({ ...state, speed }));
  },

  reset: () => {
    set(INITIAL_STATE);
  },
}));
