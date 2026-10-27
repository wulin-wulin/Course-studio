import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Layers3,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Trees,
  X,
} from "lucide-react";
import { useCourseGenerationStore } from "@/course/generation/generationStore";
import "./CourseCatalog.css";
import type { CourseEdge, CourseGroupLayout } from "./catalogGraph";

/**
 * The small, stable representation returned by GET /api/courses.
 *
 * Keep this separate from a course's editable course.json: the catalogue can
 * render a course without downloading its full forest index.
 */
export type CourseSummary = {
  id: string;
  title: string;
  description?: string;
  language?: string;
  revision?: string | number;
  clusters?: number;
  points?: number;
  placeholder?: boolean;
  invalid?: boolean;
};

export type CourseCatalogGroup = {
  id: string;
  name: string;
  order: number;
  course_ids: string[];
  edges: CourseEdge[];
  layout: CourseGroupLayout;
};

type CourseCatalogProps = {
  onOpenGroup: (groupId: string) => void;
  onOpenGeneration: (conversationId: string) => void;
  onStartGenerationDemo: () => void;
};

const COURSE_API = "/api/courses";
const CATALOG_API = "/api/courses/catalog";

export function CourseCatalog({
  onOpenGroup,
  onOpenGeneration,
  onStartGenerationDemo,
}: CourseCatalogProps) {
  const liveRuns = useCourseGenerationStore((state) => state.liveRuns);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [groups, setGroups] = useState<CourseCatalogGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const loadCourses = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoadError(null);
    setIsRefreshing(true);

    try {
      const [coursesResponse, catalogResponse] = await Promise.all([
        fetch(COURSE_API, { cache: "no-store" }),
        fetch(CATALOG_API, { cache: "no-store" }),
      ]);
      if (!coursesResponse.ok) {
        throw new Error(`课程列表请求失败（${coursesResponse.status}）`);
      }
      if (!catalogResponse.ok) {
        throw new Error(`课程分类请求失败（${catalogResponse.status}）`);
      }

      const [coursesPayload, catalogPayload]: [unknown, unknown] = await Promise.all([
        coursesResponse.json(),
        catalogResponse.json(),
      ]);
      const nextCourses = unwrapCourses(coursesPayload);
      const nextGroups = unwrapCatalogGroups(catalogPayload);
      if (!nextCourses || !nextGroups) {
        throw new Error("课程目录格式无效");
      }

      if (!mountedRef.current || requestId !== requestRef.current) return;
      setCourses(nextCourses);
      setGroups(nextGroups);
      setCatalogError(null);
    } catch (error) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : "课程列表加载失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  const mutateCatalog = useCallback(
    async (url: string, options: RequestInit) => {
      setCatalogBusy(true);
      setCatalogError(null);
      try {
        const response = await fetch(url, {
          ...options,
          headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        });
        if (!response.ok) {
          let detail = `操作失败（${response.status}）`;
          try {
            const payload = await response.json();
            if (isRecord(payload) && typeof payload.detail === "string") detail = payload.detail;
          } catch {
            // Keep the status message when the server does not return JSON.
          }
          throw new Error(detail);
        }
        await loadCourses();
        return true;
      } catch (error) {
        setCatalogError(error instanceof Error ? error.message : "课程分类操作失败");
        return false;
      } finally {
        setCatalogBusy(false);
      }
    },
    [loadCourses],
  );

  const addGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    const succeeded = await mutateCatalog(`${CATALOG_API}/groups`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (succeeded) setNewGroupName("");
  };

  const renameGroup = async (groupId: string) => {
    const name = editingGroupName.trim();
    if (!name) return;
    const succeeded = await mutateCatalog(`${CATALOG_API}/groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (succeeded) setEditingGroupId(null);
  };

  const deleteGroup = async (group: CourseCatalogGroup) => {
    if (group.course_ids.length > 0) {
      setCatalogError("请先将该大类中的课程移入其他大类，再删除它。");
      return;
    }
    if (!window.confirm(`确定删除“${group.name}”吗？`)) return;
    await mutateCatalog(`${CATALOG_API}/groups/${encodeURIComponent(group.id)}`, {
      method: "DELETE",
    });
  };

  const moveGroup = async (groupId: string, direction: -1 | 1) => {
    const index = groups.findIndex((group) => group.id === groupId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return;
    const next = groups.map((group) => group.id);
    const currentGroupId = next[index]!;
    next[index] = next[target]!;
    next[target] = currentGroupId;
    await mutateCatalog(`${CATALOG_API}/order`, {
      method: "PATCH",
      body: JSON.stringify({ group_ids: next }),
    });
  };

  useEffect(() => {
    // StrictMode intentionally runs the effect setup twice in development.
    // Resetting the flag keeps the second (real) request eligible to update UI.
    mountedRef.current = true;
    void loadCourses();

    const onCourseDataChanged = () => {
      void loadCourses();
    };
    window.addEventListener("course-data-changed", onCourseDataChanged);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("course-data-changed", onCourseDataChanged);
    };
  }, [loadCourses]);

  const validCourses = courses.filter((course) => !course.invalid);
  const invalidCourses = courses.filter((course) => course.invalid);
  const validCourseIds = new Set(validCourses.map((course) => course.id));
  const activeGenerations = Object.values(liveRuns)
    .filter(
      (run) =>
        !run.published &&
        !(run.course?.id && validCourseIds.has(run.course.id))
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const runningGenerationCount = activeGenerations.filter(
    (run) => run.status === "running"
  ).length;
  const waitingGenerationCount = activeGenerations.filter(
    (run) => run.status === "awaiting-input"
  ).length;
  const pausedGenerationCount = activeGenerations.filter(
    (run) => run.status === "paused" || run.status === "error"
  ).length;

  return (
    <main className="course-catalog" aria-label="学科大类">
      <div className="course-catalog__inner">
        <header className="course-catalog__hero">
          <p className="course-catalog__eyebrow">
            <Trees aria-hidden="true" size={17} />
            知识森林
          </p>
          <h2>探索你的知识森林</h2>
          <p className="course-catalog__intro">
            从一个学科开始，探索课程与课程之间的学习路径。
          </p>
        </header>

        <div className="course-catalog__heading-row">
          <div className="course-catalog__heading-copy">
            <span>学科大类</span>
            <strong>
              {isLoading
                ? "正在整理课程…"
                : [
                    `${groups.length} 个大类 · ${validCourses.length} 门课程`,
                    runningGenerationCount > 0
                      ? `${runningGenerationCount} 门创建中`
                      : "",
                    waitingGenerationCount > 0
                      ? `${waitingGenerationCount} 门等待确认`
                      : "",
                    pausedGenerationCount > 0
                      ? `${pausedGenerationCount} 门已暂停`
                      : "",
                  ].filter(Boolean).join(" · ")}
            </strong>
          </div>
          <div className="course-catalog__heading-actions">
            <button
              type="button"
              className="course-catalog__manage"
              onClick={() => setManageOpen((open) => !open)}
              aria-expanded={manageOpen}
            >
              <FolderPlus aria-hidden="true" size={14} />
              <span>{manageOpen ? "收起管理" : "管理分类"}</span>
            </button>
            <button
              type="button"
              className="course-catalog__demo"
              onClick={onStartGenerationDemo}
            >
              <Sparkles aria-hidden="true" size={14} />
              <span>生成演示</span>
            </button>
            <button
              type="button"
              className="course-catalog__refresh"
              onClick={() => void loadCourses()}
              disabled={isRefreshing}
              aria-label="刷新课程列表"
              title="刷新课程列表"
            >
              <RefreshCw aria-hidden="true" size={15} className={isRefreshing ? "is-spinning" : undefined} />
              <span>刷新</span>
            </button>
          </div>
        </div>

        {manageOpen && (
          <section className="course-catalog__manager" aria-label="管理学科大类">
            <div className="course-catalog__manager-heading">
              <div>
                <strong>学科大类</strong>
                <span>每门课程只能归属于一个大类，课程不会被重复展示。</span>
              </div>
              <button
                type="button"
                className="course-catalog__icon-button"
                onClick={() => setManageOpen(false)}
                aria-label="关闭分类管理"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            <form className="course-catalog__manager-add" onSubmit={(event) => void addGroup(event)}>
              <input
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                maxLength={80}
                placeholder="新大类名称"
                aria-label="新大类名称"
                disabled={catalogBusy}
              />
              <button type="submit" disabled={catalogBusy || !newGroupName.trim()}>
                <FolderPlus aria-hidden="true" size={15} />
                新增大类
              </button>
            </form>
            <div className="course-catalog__manager-list">
              {groups.map((group, index) => (
                <div className="course-catalog__manager-row" key={group.id}>
                  {editingGroupId === group.id ? (
                    <input
                      value={editingGroupName}
                      onChange={(event) => setEditingGroupName(event.target.value)}
                      maxLength={80}
                      autoFocus
                      aria-label={`重命名${group.name}`}
                      disabled={catalogBusy}
                    />
                  ) : (
                    <span className="course-catalog__manager-name">{group.name}</span>
                  )}
                  <span className="course-catalog__manager-count">{group.course_ids.length} 门课程</span>
                  <div className="course-catalog__manager-actions">
                    {editingGroupId === group.id ? (
                      <button
                        type="button"
                        className="course-catalog__icon-button"
                        onClick={() => void renameGroup(group.id)}
                        disabled={catalogBusy || !editingGroupName.trim()}
                        aria-label="保存名称"
                      >
                        <Check aria-hidden="true" size={15} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="course-catalog__icon-button"
                        onClick={() => {
                          setEditingGroupId(group.id);
                          setEditingGroupName(group.name);
                        }}
                        disabled={catalogBusy}
                        aria-label={`重命名${group.name}`}
                      >
                        <Pencil aria-hidden="true" size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="course-catalog__icon-button"
                      onClick={() => void moveGroup(group.id, -1)}
                      disabled={catalogBusy || index === 0}
                      aria-label={`将${group.name}上移`}
                    >
                      <ChevronUp aria-hidden="true" size={15} />
                    </button>
                    <button
                      type="button"
                      className="course-catalog__icon-button"
                      onClick={() => void moveGroup(group.id, 1)}
                      disabled={catalogBusy || index === groups.length - 1}
                      aria-label={`将${group.name}下移`}
                    >
                      <ChevronDown aria-hidden="true" size={15} />
                    </button>
                    <button
                      type="button"
                      className="course-catalog__icon-button course-catalog__icon-button--danger"
                      onClick={() => void deleteGroup(group)}
                      disabled={catalogBusy || group.course_ids.length > 0 || groups.length <= 1}
                      aria-label={`删除${group.name}`}
                      title={
                        groups.length <= 1
                          ? "至少保留一个大类"
                          : group.course_ids.length > 0
                            ? "请先移出课程"
                            : "删除大类"
                      }
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {catalogError && <p className="course-catalog__manager-error" role="alert">{catalogError}</p>}
          </section>
        )}

        {isLoading &&
          courses.length === 0 &&
          activeGenerations.length === 0 && <CatalogState kind="loading" />}

        {loadError && courses.length === 0 && activeGenerations.length === 0 && (
          <CatalogState kind="error" message={loadError} onRetry={() => void loadCourses()} />
        )}

        {!isLoading &&
          !loadError &&
          groups.length === 0 &&
          validCourses.length === 0 &&
          activeGenerations.length === 0 && <CatalogState kind="empty" />}

        {activeGenerations.length > 0 && (
          <section className="course-catalog__generation-section" aria-label="正在创建的课程">
            <h3>正在创建</h3>
            <ul className="course-catalog__shelf" aria-label="正在创建的课程">
            {activeGenerations.map((run) => {
              const completedPoints = run.points.filter(
                (point) => point.status === "grown" || point.status === "clustered"
              ).length;
              const interrupted =
                run.status === "error" || run.status === "paused";
              const awaitingInput = run.status === "awaiting-input";
              return (
                <li key={`generation:${run.conversationId}`}>
                  <button
                    type="button"
                    className={`course-catalog__card course-catalog__card--generation ${
                      interrupted ? "is-error" : ""
                    }`}
                    onClick={() => onOpenGeneration(run.conversationId)}
                    aria-label={`查看${run.course?.title ?? "新课程"}的创建进度`}
                  >
                    <span className="course-catalog__card-icon" aria-hidden="true">
                      {interrupted ? (
                        <AlertCircle size={19} />
                      ) : awaitingInput ? (
                        <Sparkles size={19} />
                      ) : (
                        <Loader2 size={19} className="is-spinning" />
                      )}
                    </span>
                    <span className="course-catalog__generation-badge">
                      {interrupted
                        ? "创建已暂停"
                        : awaitingInput
                          ? "等待确认"
                          : "正在创建"}
                    </span>
                    <span className="course-catalog__card-title">
                      {run.course?.title ?? "正在创建的新课程"}
                    </span>
                    <span className="course-catalog__card-description">
                      {run.error || run.phaseDetail}
                    </span>
                    <span className="course-catalog__metrics">
                      <span>
                        <Layers3 aria-hidden="true" size={14} />
                        {run.clusters.length || "—"} 个知识簇
                      </span>
                      <span>
                        {completedPoints} / {run.totalPoints || "—"} 个知识点
                      </span>
                    </span>
                    <span className="course-catalog__enter">
                      {interrupted
                        ? "查看并继续创建"
                        : awaitingInput
                          ? "查看并确认"
                          : "查看生长过程"}
                      <ArrowRight aria-hidden="true" size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
            </ul>
          </section>
        )}

        {groups.length > 0 && (
          <ul className="course-catalog__shelf course-catalog__subject-shelf" aria-label="选择学科大类">
            {groups.map((group, index) => {
              const count = group.course_ids.filter((id) => validCourseIds.has(id)).length;
              return (
                <li key={group.id}>
                  <button type="button" className="course-catalog__card course-catalog__subject" onClick={() => onOpenGroup(group.id)} aria-label={`浏览${group.name}，${count}门课程`}>
                    <span className="course-catalog__subject-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className="course-catalog__card-icon" aria-hidden="true"><Layers3 size={23} /></span>
                    <span className="course-catalog__card-title">{group.name}</span>
                    <span className="course-catalog__card-description">{count > 0 ? `${count} 门课程，循着学习路径探索新的知识。` : "这片森林等待新的课程。"}</span>
                    <span className="course-catalog__enter">探索课程 <ArrowRight aria-hidden="true" size={16} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {loadError && (courses.length > 0 || activeGenerations.length > 0) && (
          <p className="course-catalog__soft-error" role="status">
            <AlertCircle aria-hidden="true" size={15} />
            课程列表暂未刷新：{loadError}
          </p>
        )}

        {catalogError && !manageOpen && (
          <p className="course-catalog__soft-error" role="status">
            <AlertCircle aria-hidden="true" size={15} />
            课程分类操作失败：{catalogError}
          </p>
        )}

        {invalidCourses.length > 0 && (
          <p className="course-catalog__soft-error" role="status">
            <AlertCircle aria-hidden="true" size={15} />
            {invalidCourses.length} 门课程的数据尚未通过校验，暂不能打开。
          </p>
        )}
      </div>
    </main>
  );
}

function CatalogState({
  kind,
  message,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  message?: string;
  onRetry?: () => void;
}) {
  if (kind === "loading") {
    return (
      <div className="course-catalog__state" role="status">
        <Loader2 aria-hidden="true" size={24} className="is-spinning" />
        <span>正在加载课程导览…</span>
      </div>
    );
  }

  if (kind === "error") {
    return (
      <div className="course-catalog__state course-catalog__state--error" role="alert">
        <AlertCircle aria-hidden="true" size={24} />
        <strong>无法加载课程列表</strong>
        <span>{message}</span>
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="course-catalog__state">
      <BookOpen aria-hidden="true" size={24} />
      <strong>还没有可展示的课程</strong>
      <span>课程创建完成后会自动显示在这里。</span>
    </div>
  );
}

export function unwrapCourses(payload: unknown): CourseSummary[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.courses)) return null;

  const courses: CourseSummary[] = [];
  for (const item of payload.courses) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return null;
    courses.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      description: typeof item.description === "string" ? item.description : undefined,
      language: typeof item.language === "string" ? item.language : undefined,
      revision: typeof item.revision === "string" || typeof item.revision === "number" ? item.revision : undefined,
      clusters: toNonNegativeInteger(item.clusters),
      points: toNonNegativeInteger(item.points),
      placeholder: item.placeholder === true,
      invalid: item.invalid === true,
    });
  }
  return courses;
}

export function unwrapCatalogGroups(payload: unknown): CourseCatalogGroup[] | null {
  if (!isRecord(payload) || !isRecord(payload.catalog) || !Array.isArray(payload.catalog.groups)) {
    return null;
  }
  const groups: CourseCatalogGroup[] = [];
  for (const item of payload.catalog.groups) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.name !== "string" ||
      !Array.isArray(item.course_ids) ||
      item.course_ids.some((courseId) => typeof courseId !== "string")
    ) {
      return null;
    }
    groups.push({
      id: item.id,
      name: item.name,
      order: toNonNegativeInteger(item.order) ?? groups.length,
      course_ids: item.course_ids as string[],
      edges: Array.isArray(item.edges) ? item.edges.filter((edge): edge is CourseEdge => isRecord(edge) && typeof edge.fromId === "string" && typeof edge.toId === "string") : [],
      layout: readCourseGroupLayout(item.layout),
    });
  }
  return groups.sort((left, right) => left.order - right.order);
}

function readCourseGroupLayout(value: unknown): CourseGroupLayout {
  if (!isRecord(value) || !isRecord(value.positions)) return { mode: "hybrid", positions: {} };
  const positions: CourseGroupLayout["positions"] = {};
  for (const [courseId, rawPosition] of Object.entries(value.positions)) {
    if (!isRecord(rawPosition) || typeof rawPosition.x !== "number" || !Number.isFinite(rawPosition.x) || typeof rawPosition.y !== "number" || !Number.isFinite(rawPosition.y)) continue;
    positions[courseId] = { x: rawPosition.x, y: rawPosition.y, pinned: rawPosition.pinned !== false };
  }
  return { mode: "hybrid", positions };
}

function toNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
