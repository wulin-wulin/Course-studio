import { create } from "zustand";
import type { ForestCluster } from "@/course/forest/types";
import type {
  CourseGenerationEvent,
  CourseGenerationSnapshot,
  GenerationCourse,
  GenerationGate,
  GenerationPointState,
  GenerationRunStatus,
  LiveCourseGenerationRun,
} from "./types";
import { GENERATION_GATES } from "./types";

type CourseGenerationState = {
  status: GenerationRunStatus;
  mode: "demo" | "live";
  conversationId: string | null;
  course: GenerationCourse | null;
  gate: GenerationGate | null;
  phaseLabel: string;
  phaseDetail: string;
  totalPoints: number;
  points: GenerationPointState[];
  clusters: ForestCluster[];
  speed: number;
  error: string | null;
  liveRuns: Record<string, LiveCourseGenerationRun>;
  requestDemo: () => void;
  startLive: (conversationId: string) => void;
  openLive: (conversationId: string) => void;
  applySnapshot: (snapshot: unknown) => void;
  markLiveError: (conversationId: string, message: string) => void;
  removeLive: (conversationId: string) => void;
  tickEstimates: (now?: number) => void;
  markLoading: () => void;
  applyEvent: (event: CourseGenerationEvent) => void;
  setPaused: (paused: boolean) => void;
  setSpeed: (speed: number) => void;
  leaveView: () => void;
  reset: () => void;
};

const STORAGE_KEY = "course-studio:live-course-generations:v1";
const MAX_PERSISTED_RUNS = 8;

const EMPTY_ACTIVE_STATE = {
  status: "idle" as const,
  mode: "demo" as const,
  conversationId: null,
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

const GATE_MAP: Record<CourseGenerationSnapshot["gate"], GenerationGate> = {
  G0: "G0_SCOPE",
  G1: "G1_INDEX",
  G2: "G2_IDENTITY_REVIEW",
  G3: "G3_CONTENT",
  G4: "G4_ANIMATIONS",
  G5: "G5_CONTENT_READY",
  G6: "G6_GRAPH",
  G7: "G7_RELEASE_READY",
};

const PHASE_COPY: Record<GenerationGate, { label: string; detail: string }> = {
  G0_SCOPE: {
    label: "等待确认课程范围",
    detail: "在右侧对话中确定课程名称、受众和内容边界。",
  },
  G1_INDEX: {
    label: "知识点目录已经形成",
    detail: "知识种子正在依次落入课程森林。",
  },
  G2_IDENTITY_REVIEW: {
    label: "复核知识点身份",
    detail: "正在检查知识点名称、粒度和课程边界。",
  },
  G3_CONTENT: {
    label: "编写知识点内容",
    detail: "课程助手正在并行完善知识树的核心内容。",
  },
  G4_ANIMATIONS: {
    label: "设计教学动画",
    detail: "正在为适合动态讲解的知识点准备教学动画。",
  },
  G5_CONTENT_READY: {
    label: "校验课程内容",
    detail: "正在检查知识点完整性、引用和资源一致性。",
  },
  G6_GRAPH: {
    label: "知识簇正在形成",
    detail: "知识树正在按照聚类结果移动到各自的知识区域。",
  },
  G7_RELEASE_READY: {
    label: "课程发布完成",
    detail: "知识点、知识簇和正式课程包已经准备完成。",
  },
};

const CLUSTER_PALETTE = [
  { accent: "#4f8b73", soft: "#dcebe2", dark: "#2f6653" },
  { accent: "#547ca8", soft: "#dce7f1", dark: "#345b83" },
  { accent: "#b77a45", soft: "#f2e4d6", dark: "#875329" },
  { accent: "#8a6ca8", soft: "#e9e0f1", dark: "#60457d" },
  { accent: "#b05f6c", soft: "#f2dde1", dark: "#843b49" },
  { accent: "#688f4e", soft: "#e1ead9", dark: "#466b31" },
  { accent: "#4d9094", soft: "#d9ebeb", dark: "#2d686c" },
  { accent: "#a28642", soft: "#eee7d4", dark: "#745e29" },
];

const persistedRuns = loadPersistedRuns();

export const useCourseGenerationStore = create<CourseGenerationState>((set) => ({
  ...EMPTY_ACTIVE_STATE,
  liveRuns: persistedRuns,

  requestDemo: () => {
    set((state) => ({
      ...EMPTY_ACTIVE_STATE,
      status: "requested",
      mode: "demo",
      speed: state.speed,
      liveRuns: state.liveRuns,
    }));
  },

  startLive: (conversationId) => {
    const normalizedId = conversationId.trim();
    if (!normalizedId) return;
    set((state) => {
      const run = state.liveRuns[normalizedId] ?? makePlaceholderRun(normalizedId);
      const liveRuns = { ...state.liveRuns, [normalizedId]: run };
      return { ...state, ...activeStateFromRun(run), liveRuns };
    });
  },

  openLive: (conversationId) => {
    const normalizedId = conversationId.trim();
    if (!normalizedId) return;
    set((state) => {
      const run = state.liveRuns[normalizedId];
      if (!run) return state;
      return { ...state, ...activeStateFromRun(run) };
    });
  },

  applySnapshot: (value) => {
    const snapshot = normalizeSnapshot(value);
    if (!snapshot) return;
    set((state) => {
      const previous =
        state.liveRuns[snapshot.conversation_id] ??
        makePlaceholderRun(snapshot.conversation_id);
      const stableSnapshot = stabilizeSnapshot(snapshot, previous);
      if (!stableSnapshot) return state;
      const snapshotKey = makeSnapshotKey(stableSnapshot);
      if (previous.snapshotKey === snapshotKey && previous.status !== "error") {
        return state;
      }

      const run = runFromSnapshot(stableSnapshot, previous, snapshotKey);
      const liveRuns = {
        ...state.liveRuns,
        [snapshot.conversation_id]: run,
      };
      if (
        state.mode === "live" &&
        state.conversationId === snapshot.conversation_id
      ) {
        return { ...state, ...activeStateFromRun(run), liveRuns };
      }
      return { ...state, liveRuns };
    });
  },

  markLiveError: (conversationId, message) => {
    const normalizedId = conversationId.trim();
    const normalizedMessage = message.trim() || "课程创建流程暂时中断";
    if (!normalizedId) return;
    set((state) => {
      const previous =
        state.liveRuns[normalizedId] ?? makePlaceholderRun(normalizedId);
      if (previous.published) return state;
      const run: LiveCourseGenerationRun = {
        ...previous,
        status: "error",
        error: normalizedMessage,
        updatedAt: Date.now(),
      };
      const liveRuns = { ...state.liveRuns, [normalizedId]: run };
      if (state.mode === "live" && state.conversationId === normalizedId) {
        return { ...state, ...activeStateFromRun(run), liveRuns };
      }
      return { ...state, liveRuns };
    });
  },

  removeLive: (conversationId) => {
    const normalizedId = conversationId.trim();
    if (!normalizedId) return;
    set((state) => {
      if (!state.liveRuns[normalizedId]) return state;
      const liveRuns = { ...state.liveRuns };
      delete liveRuns[normalizedId];
      if (state.mode === "live" && state.conversationId === normalizedId) {
        return {
          ...state,
          ...EMPTY_ACTIVE_STATE,
          speed: state.speed,
          liveRuns,
        };
      }
      return { ...state, liveRuns };
    });
  },

  tickEstimates: (now = Date.now()) => {
    set((state) => {
      if (state.mode !== "live" || !state.conversationId) return state;
      const previous = state.liveRuns[state.conversationId];
      if (!previous || previous.status !== "running") return state;
      let changed = false;
      const points = previous.points.map((point) => {
        if (point.status !== "generating") return point;
        const startedAt = point.progressStartedAt ?? now;
        // Fast at first, then deliberately asymptotic: it can never imply that
        // an LLM write is complete before the filesystem observer confirms it.
        const elapsed = Math.max(0, now - startedAt);
        const progress = Math.min(92, Math.round(8 + 84 * (1 - Math.exp(-elapsed / 70_000))));
        if (progress === point.progress && point.progressStartedAt) return point;
        changed = true;
        return { ...point, progress, progressStartedAt: startedAt };
      });
      if (!changed) return state;
      const run = { ...previous, points };
      return {
        ...state,
        points,
        liveRuns: { ...state.liveRuns, [state.conversationId]: run },
      };
    });
  },

  markLoading: () => {
    set((state) => {
      if (state.mode !== "demo") return state;
      return { ...state, status: "loading", error: null };
    });
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "generation_started":
        set((state) => ({
          ...EMPTY_ACTIVE_STATE,
          status: "running",
          mode: "demo",
          speed: state.speed,
          liveRuns: state.liveRuns,
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
          const existing = state.points.findIndex(
            (point) => point.id === event.point.id
          );
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
            point.id === event.pointId
              ? { ...point, status: "grown", progress: 100 }
              : point
          ),
        }));
        return;

      case "clusters_ready":
        set((state) => ({
          ...state,
          clusters: event.clusters,
          points: state.points.map((point) => ({
            ...point,
            status: "clustered",
            progress: 100,
          })),
        }));
        return;

      case "generation_completed":
        set((state) => ({
          ...state,
          status: "completed",
          gate: "G7_RELEASE_READY",
          phaseLabel: "课程发布完成",
          phaseDetail: "知识点、知识簇和学习路径已经汇成完整森林。",
          points: state.points.map((point) => ({
            ...point,
            status: "clustered",
            progress: 100,
          })),
        }));
        return;

      case "generation_failed":
        set((state) => ({ ...state, status: "error", error: event.message }));
    }
  },

  setPaused: (paused) => {
    set((state) => {
      if (
        state.mode !== "demo" ||
        state.status === "completed" ||
        state.status === "error"
      ) {
        return state;
      }
      return { ...state, status: paused ? "paused" : "running" };
    });
  },

  setSpeed: (speed) => set((state) => ({ ...state, speed })),

  leaveView: () => {
    set((state) => ({
      ...EMPTY_ACTIVE_STATE,
      speed: state.speed,
      liveRuns: state.liveRuns,
    }));
  },

  reset: () => {
    set((state) => ({
      ...EMPTY_ACTIVE_STATE,
      speed: state.speed,
      liveRuns: state.liveRuns,
    }));
  },
}));

if (typeof window !== "undefined") {
  useCourseGenerationStore.subscribe((state, previous) => {
    if (state.liveRuns === previous.liveRuns) return;
    persistRuns(state.liveRuns);
  });
}

function makePlaceholderRun(conversationId: string): LiveCourseGenerationRun {
  return {
    conversationId,
    status: "running",
    course: null,
    gate: "G0_SCOPE",
    phaseLabel: PHASE_COPY.G0_SCOPE.label,
    phaseDetail: PHASE_COPY.G0_SCOPE.detail,
    totalPoints: 0,
    points: [],
    clusters: [],
    published: false,
    publishedCourseId: null,
    error: null,
    updatedAt: Date.now(),
    snapshotKey: "",
  };
}

function activeStateFromRun(run: LiveCourseGenerationRun) {
  return {
    status: run.status,
    mode: "live" as const,
    conversationId: run.conversationId,
    course: run.course,
    gate: run.gate,
    phaseLabel: run.phaseLabel,
    phaseDetail: run.phaseDetail,
    totalPoints: run.totalPoints,
    points: run.points,
    clusters: run.clusters,
    error: run.error,
  };
}

function runFromSnapshot(
  snapshot: CourseGenerationSnapshot,
  previous: LiveCourseGenerationRun,
  snapshotKey: string
): LiveCourseGenerationRun {
  const gate = GATE_MAP[snapshot.gate];
  const phase = PHASE_COPY[gate];
  const now = Date.now();
  const clustered = snapshot.clusters.length > 0 && snapshot.gate >= "G6";
  const clusters = buildClusters(snapshot);
  const previousPoints = new Map(previous.points.map((point) => [point.id, point]));
  const incompleteIds =
    gate === "G3_CONTENT" ||
    gate === "G4_ANIMATIONS" ||
    gate === "G5_CONTENT_READY"
      ? new Set(
          snapshot.points
            .filter((point) => !point.complete)
            .sort((left, right) => left.order - right.order)
            .slice(0, 4)
            .map((point) => point.id)
        )
      : new Set<string>();
  const pointPositions = buildClusteredPointPositions(snapshot);
  const points: GenerationPointState[] = snapshot.points
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((point) => {
      const previousPoint = previousPoints.get(point.id);
      const status = clustered
        ? "clustered"
        : point.complete
          ? "grown"
          : incompleteIds.has(point.id)
            ? "generating"
            : "planned";
      const progressStartedAt =
        status === "generating"
          ? previousPoint?.status === "generating"
            ? previousPoint.progressStartedAt ?? now
            : now
          : undefined;
      return {
        id: point.id,
        title: point.title,
        order: point.order,
        importance: point.importance ?? 0.5,
        clusterId: point.clusterId ?? "unclustered",
        pos: pointPositions.get(point.id) ?? [2000, 1500],
        scale: 0.9 + (point.importance ?? 0.5) * 0.25,
        status,
        progress:
          status === "generating"
            ? previousPoint?.status === "generating"
              ? previousPoint.progress ?? 8
              : 8
            : status === "planned"
              ? 0
              : 100,
        progressStartedAt,
      };
    });

  return {
    conversationId: snapshot.conversation_id,
    status: snapshot.published ? "completed" : "running",
    course: snapshot.course,
    gate,
    phaseLabel: phase.label,
    phaseDetail: phase.detail,
    totalPoints: Math.max(snapshot.total_points, points.length),
    points,
    clusters,
    published: snapshot.published,
    publishedCourseId: snapshot.published ? snapshot.course?.id ?? null : null,
    error: null,
    updatedAt: now,
    snapshotKey,
  };
}

function buildClusters(snapshot: CourseGenerationSnapshot): ForestCluster[] {
  return snapshot.clusters
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((cluster, index) => {
      const colors =
        CLUSTER_PALETTE[index % CLUSTER_PALETTE.length] ??
        CLUSTER_PALETTE[0]!;
      return {
        id: cluster.id,
        title: cluster.title,
        subtitle: cluster.subtitle,
        description: cluster.description,
        ...colors,
      };
    });
}

function buildClusteredPointPositions(
  snapshot: CourseGenerationSnapshot
): Map<string, [number, number]> {
  const result = new Map<string, [number, number]>();
  const orderedClusters = snapshot.clusters
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  if (orderedClusters.length === 0) return result;

  const columns = Math.max(1, Math.ceil(Math.sqrt(orderedClusters.length * 1.25)));
  const rows = Math.ceil(orderedClusters.length / columns);
  const xGap = Math.min(780, 2_250 / Math.max(1, columns - 1));
  const yGap = Math.min(680, 1_550 / Math.max(1, rows - 1));
  orderedClusters.forEach((cluster, clusterIndex) => {
    const row = Math.floor(clusterIndex / columns);
    const column = clusterIndex % columns;
    const rowCount = Math.min(columns, orderedClusters.length - row * columns);
    const centerX = 2000 + (column - (rowCount - 1) / 2) * xGap + (row % 2 ? xGap * 0.12 : 0);
    const centerY = 1500 + (row - (rows - 1) / 2) * yGap;
    const members = snapshot.points
      .filter((point) => point.clusterId === cluster.id)
      .sort((left, right) => left.order - right.order);
    members.forEach((point, memberIndex) => {
      const ring = Math.floor(Math.sqrt(memberIndex));
      const ringStart = ring * ring;
      const ringSize = Math.max(1, (ring + 1) * (ring + 1) - ringStart);
      const angle = ((memberIndex - ringStart) / ringSize) * Math.PI * 2 + clusterIndex * 0.7;
      const radius = memberIndex === 0 ? 0 : 110 + ring * 78;
      result.set(point.id, [
        Math.round(centerX + Math.cos(angle) * radius),
        Math.round(centerY + Math.sin(angle) * radius * 0.82),
      ]);
    });
  });
  return result;
}

function normalizeSnapshot(value: unknown): CourseGenerationSnapshot | null {
  if (!isRecord(value)) return null;
  const conversationId = readString(value, "conversation_id", "conversationId");
  const rawGate = readString(value, "gate");
  if (!conversationId || !isSnapshotGate(rawGate)) return null;

  const rawCourse = value.course;
  const course =
    rawCourse === null
      ? null
      : isRecord(rawCourse)
        ? normalizeCourse(rawCourse)
        : null;
  if (rawCourse !== null && !course) return null;

  const points = Array.isArray(value.points)
    ? value.points.flatMap((point, index) => {
        if (!isRecord(point)) return [];
        const id = readString(point, "id");
        const title = readString(point, "title");
        if (!id || !title) return [];
        return [{
          id,
          title,
          order: readNumber(point, "order") ?? index,
          importance: readNumber(point, "importance"),
          complete: point.complete === true,
          clusterId: readString(point, "clusterId", "cluster_id") || undefined,
        }];
      })
    : [];
  const clusters = Array.isArray(value.clusters)
    ? value.clusters.flatMap((cluster, index) => {
        if (!isRecord(cluster)) return [];
        const id = readString(cluster, "id");
        const title = readString(cluster, "title");
        if (!id || !title) return [];
        return [{
          id,
          title,
          subtitle: readString(cluster, "subtitle") || undefined,
          description: readString(cluster, "description") || undefined,
          order: readNumber(cluster, "order") ?? index,
        }];
      })
    : [];
  return {
    conversation_id: conversationId,
    gate: rawGate,
    course,
    total_points: Math.max(0, Math.round(readNumber(value, "total_points", "totalPoints") ?? points.length)),
    points,
    clusters,
    published: value.published === true,
  };
}

function normalizeCourse(value: Record<string, unknown>): GenerationCourse | null {
  const id = readString(value, "id");
  const title = readString(value, "title");
  if (!id || !title) return null;
  return {
    id,
    title,
    description: readString(value, "description") || undefined,
  };
}

function makeSnapshotKey(snapshot: CourseGenerationSnapshot) {
  return JSON.stringify(snapshot);
}

function stabilizeSnapshot(
  snapshot: CourseGenerationSnapshot,
  previous: LiveCourseGenerationRun
): CourseGenerationSnapshot | null {
  const previousCourseId = previous.course?.id ?? "";
  const incomingCourseId = snapshot.course?.id ?? "";
  if (
    previousCourseId &&
    incomingCourseId &&
    previousCourseId !== incomingCourseId
  ) {
    return snapshot;
  }
  if (previousCourseId && !incomingCourseId) return null;

  const previousRank = GENERATION_GATES.indexOf(previous.gate);
  const incomingRank = GENERATION_GATES.indexOf(GATE_MAP[snapshot.gate]);
  if (incomingRank < previousRank) return null;

  const previousPointIds = previous.points.map((point) => point.id);
  const incomingPointIds = snapshot.points.map((point) => point.id);
  if (
    previousRank >= GENERATION_GATES.indexOf("G3_CONTENT") &&
    previousPointIds.join("\u0000") !== incomingPointIds.join("\u0000")
  ) {
    return null;
  }

  const completedIds = new Set(
    previous.points
      .filter(
        (point) => point.status === "grown" || point.status === "clustered"
      )
      .map((point) => point.id)
  );
  if (completedIds.size === 0) return snapshot;
  return {
    ...snapshot,
    points: snapshot.points.map((point) =>
      completedIds.has(point.id) ? { ...point, complete: true } : point
    ),
  };
}

function loadPersistedRuns(): Record<string, LiveCourseGenerationRun> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const runs: Record<string, LiveCourseGenerationRun> = {};
    for (const item of parsed) {
      const run = normalizePersistedRun(item);
      if (run) runs[run.conversationId] = run;
    }
    return runs;
  } catch {
    return {};
  }
}

function persistRuns(runs: Record<string, LiveCourseGenerationRun>) {
  try {
    const recent = Object.values(runs)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PERSISTED_RUNS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Quota/privacy errors must never interrupt course creation.
  }
}

function normalizePersistedRun(value: unknown): LiveCourseGenerationRun | null {
  if (!isRecord(value)) return null;
  const conversationId = readString(value, "conversationId");
  const rawGate = readString(value, "gate");
  if (!conversationId || !isGenerationGate(rawGate)) return null;
  const course =
    value.course === null
      ? null
      : isRecord(value.course)
        ? normalizeCourse(value.course)
        : null;
  const points = Array.isArray(value.points)
    ? value.points.filter(isPersistedPoint) as GenerationPointState[]
    : [];
  const clusters = Array.isArray(value.clusters)
    ? value.clusters.filter(isPersistedCluster) as ForestCluster[]
    : [];
  const published = value.published === true;
  const status = value.status === "error"
    ? "error"
    : published || value.status === "completed"
      ? "completed"
      : "running";
  return {
    conversationId,
    status,
    course,
    gate: rawGate,
    phaseLabel: readString(value, "phaseLabel") || PHASE_COPY[rawGate].label,
    phaseDetail: readString(value, "phaseDetail") || PHASE_COPY[rawGate].detail,
    totalPoints: Math.max(0, Math.round(readNumber(value, "totalPoints") ?? points.length)),
    points,
    clusters,
    published,
    publishedCourseId: readString(value, "publishedCourseId") || null,
    error: readString(value, "error") || null,
    updatedAt: readNumber(value, "updatedAt") ?? Date.now(),
    snapshotKey: readString(value, "snapshotKey"),
  };
}

function isPersistedPoint(value: unknown): value is GenerationPointState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.order === "number" &&
    typeof value.clusterId === "string" &&
    Array.isArray(value.pos) &&
    value.pos.length === 2 &&
    ["planned", "generating", "grown", "clustered"].includes(String(value.status))
  );
}

function isPersistedCluster(value: unknown): value is ForestCluster {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.accent === "string"
  );
}

function readString(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function readNumber(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function isSnapshotGate(value: string): value is CourseGenerationSnapshot["gate"] {
  return ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"].includes(value);
}

function isGenerationGate(value: string): value is GenerationGate {
  return [
    "G0_SCOPE",
    "G1_INDEX",
    "G2_IDENTITY_REVIEW",
    "G3_CONTENT",
    "G4_ANIMATIONS",
    "G5_CONTENT_READY",
    "G6_GRAPH",
    "G7_RELEASE_READY",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
