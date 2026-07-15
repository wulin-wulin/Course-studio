import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { ArrowLeft, BookOpen, Loader2, RotateCcw, Search } from "lucide-react";
import { buildSceneInputs } from "@/course/forest/forestAdapter";
import type {
  CourseDataChangedDetail,
  CourseMeta,
  ForestIndex,
  ForestPoint,
} from "@/course/forest/types";
// The renderer is a deliberately isolated copy of the original course forest.
// It is plain Three.js, not a React Three Fiber canvas.
// @ts-expect-error The vendor module is JavaScript without declaration files.
import { Scene3D } from "@/course/forest/vendor/scene3d.js";
import "./courseForest.css";

type SceneHandle = {
  render: () => void;
  resize: (width: number, height: number) => void;
  raycast: (x: number, y: number) => string | null;
  flyTo: (id: string) => void;
  flyToCluster: (id: string) => void;
  resetView: () => void;
  setHover: (id: string | null) => void;
  dispose: () => void;
};

type CourseForestViewportProps = {
  course: CourseMeta;
  onOpenPoint: (point: ForestPoint) => void;
  onBackToCatalog: () => void;
};

/** The map view for one selected course. Point selection opens a dedicated reader. */
export function CourseForestViewport({
  course,
  onOpenPoint,
  onBackToCatalog,
}: CourseForestViewportProps) {
  const [index, setIndex] = useState<ForestIndex | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [legendHidden, setLegendHidden] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const sceneRef = useRef<SceneHandle | null>(null);
  const courseApi = `/api/courses/${encodeURIComponent(course.id)}`;

  useEffect(() => {
    // React StrictMode deliberately mounts, cleans up, and mounts once more in
    // development. Resetting this flag in setup keeps the second mount live.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadIndex = useCallback(async () => {
    const requestId = ++requestRef.current;
    setIsRefreshing(true);
    setLoadError(null);

    try {
      const response = await fetch(`${courseApi}/index`, { cache: "no-store" });
      if (!response.ok) throw new Error(`课程索引请求失败（${response.status}）`);
      const payload: unknown = await response.json();
      const nextIndex = unwrapForestIndex(payload);
      if (!nextIndex) throw new Error("课程索引格式无效");
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setIndex(nextIndex);
    } catch (error) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : "课程索引加载失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [courseApi]);

  useEffect(() => {
    setIndex(null);
    setIsLoading(true);
    setLegendHidden(false);
    void loadIndex();
  }, [loadIndex]);

  useEffect(() => {
    const onCourseDataChanged = (event: Event) => {
      const detail = (event as CustomEvent<CourseDataChangedDetail>).detail;
      if (detail?.course_id && detail.course_id !== course.id) return;
      void loadIndex();
    };

    window.addEventListener("course-data-changed", onCourseDataChanged);
    return () => window.removeEventListener("course-data-changed", onCourseDataChanged);
  }, [course.id, loadIndex]);

  const clusterById = useMemo(() => {
    const result = new Map<string, string>();
    for (const cluster of index?.clusters ?? []) result.set(cluster.id, cluster.title);
    return result;
  }, [index]);

  const pointCountByCluster = useMemo(() => {
    const result = new Map<string, number>();
    for (const point of index?.points ?? []) {
      result.set(point.clusterId, (result.get(point.clusterId) ?? 0) + 1);
    }
    return result;
  }, [index]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || !index) return [];
    return index.points
      .filter((point) => {
        const haystack = `${point.title} ${point.shortSummary ?? ""} ${(point.keyTerms ?? []).join(" ")}`;
        return haystack.toLocaleLowerCase().includes(normalized);
      })
      .slice(0, 12);
  }, [index, query]);

  const openPoint = useCallback(
    (pointId: string) => {
      const point = index?.points.find((item) => item.id === pointId);
      if (!point) return;
      setQuery("");
      onOpenPoint(point);
    },
    [index, onOpenPoint]
  );

  return (
    <section className="course-forest" aria-label={`${course.title}知识森林`}>
      <div className="course-forest__toolbar">
        <button
          type="button"
          className="course-forest__back-button"
          onClick={onBackToCatalog}
          aria-label="返回课程导览"
          title="返回课程导览"
        >
          <ArrowLeft aria-hidden="true" size={16} />
        </button>
        <div className="course-forest__course-title">
          <BookOpen aria-hidden="true" size={18} />
          <div>
            <strong>{course.title}</strong>
            <span>
              {index
                ? `${index.points.length} 个知识点 · ${index.clusters.length} 个知识簇`
                : course.subtitle || course.description || "课程知识森林"}
            </span>
          </div>
        </div>

        <div className="course-forest__search">
          <Search aria-hidden="true" size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索知识点"
            aria-label="搜索知识点"
          />
          {searchResults.length > 0 && (
            <div className="course-forest__search-results" role="listbox">
              {searchResults.map((point) => (
                <button key={point.id} type="button" role="option" onClick={() => openPoint(point.id)}>
                  <strong>{point.title}</strong>
                  <small>{clusterById.get(point.clusterId)}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <select
          className="course-forest__cluster-select"
          aria-label="定位知识簇"
          defaultValue=""
          onChange={(event) => {
            const clusterId = event.target.value;
            if (clusterId) sceneRef.current?.flyToCluster(clusterId);
            event.currentTarget.value = "";
          }}
        >
          <option value="">定位知识簇</option>
          {(index?.clusters ?? []).map((cluster) => (
            <option key={cluster.id} value={cluster.id}>
              {cluster.title}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="course-forest__icon-button"
          onClick={() => sceneRef.current?.resetView()}
          title="重置视图"
          aria-label="重置视图"
        >
          <RotateCcw aria-hidden="true" size={16} />
        </button>
      </div>

      {index && <ForestScene index={index} sceneRef={sceneRef} onPointClick={openPoint} />}

      {isLoading && !index && <ForestLoading />}
      {loadError && !index && <ForestError message={loadError} onRetry={() => void loadIndex()} />}
      {isRefreshing && index && (
        <div className="course-forest__syncing" role="status">
          <Loader2 aria-hidden="true" size={14} />
          正在同步课程数据
        </div>
      )}

      {index && !legendHidden && (
        <aside className="course-forest__legend" aria-label="知识簇图例">
          <div className="course-forest__legend-head">
            <h2>知识簇</h2>
            <button type="button" onClick={() => setLegendHidden(true)}>
              隐藏
            </button>
          </div>
          <div className="course-forest__legend-list">
            {index.clusters.map((cluster) => (
              <button
                key={cluster.id}
                type="button"
                onClick={() => sceneRef.current?.flyToCluster(cluster.id)}
              >
                <i style={{ backgroundColor: cluster.accent }} aria-hidden="true" />
                <span>{cluster.title}</span>
                <small>{pointCountByCluster.get(cluster.id) ?? 0}</small>
              </button>
            ))}
          </div>
        </aside>
      )}

      {index && legendHidden && (
        <button type="button" className="course-forest__legend-restore" onClick={() => setLegendHidden(false)}>
          显示知识簇
        </button>
      )}
    </section>
  );
}

function ForestScene({
  index,
  sceneRef,
  onPointClick,
}: {
  index: ForestIndex;
  sceneRef: MutableRefObject<SceneHandle | null>;
  onPointClick: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onPointClickRef = useRef(onPointClick);
  onPointClickRef.current = onPointClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { layout, data } = buildSceneInputs(index);
    const scene = new Scene3D(container, layout, data) as SceneHandle;
    sceneRef.current = scene;

    let animationFrame = 0;
    const render = () => {
      animationFrame = window.requestAnimationFrame(render);
      scene.render();
    };
    render();

    const resize = () => scene.resize(container.clientWidth, container.clientHeight);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    // The map is mounted after the route-level course fetch resolves. Defer
    // the first measurement to the next frame so flex layout has settled;
    // constructing WebGL with a transient zero-height canvas leaves Three.js
    // with an invalid projection in some browsers.
    const resizeFrame = window.requestAnimationFrame(resize);

    let pointerDownX = 0;
    let pointerDownY = 0;
    let isDragging = false;
    const onPointerDown = (event: PointerEvent) => {
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      isDragging = true;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (isDragging) return;
      const pointId = scene.raycast(event.clientX, event.clientY);
      scene.setHover(pointId);
      container.style.cursor = pointId ? "pointer" : "grab";
    };
    const onPointerUp = () => {
      isDragging = false;
    };
    const onClick = (event: MouseEvent) => {
      if (Math.abs(event.clientX - pointerDownX) > 6 || Math.abs(event.clientY - pointerDownY) > 6) return;
      const pointId = scene.raycast(event.clientX, event.clientY);
      if (pointId) onPointClickRef.current(pointId);
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    container.addEventListener("click", onClick);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("click", onClick);
      scene.dispose();
      container.replaceChildren();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, [index, sceneRef]);

  return <div ref={containerRef} className="course-forest__canvas" aria-label="可交互的知识森林地图" />;
}

function ForestLoading() {
  return (
    <div className="course-forest__state" role="status">
      <Loader2 aria-hidden="true" size={26} />
      <span>正在加载知识森林…</span>
    </div>
  );
}

function ForestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="course-forest__state course-forest__state--error" role="alert">
      <strong>无法加载课程数据</strong>
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function unwrapForestIndex(payload: unknown): ForestIndex | null {
  const candidate = isRecord(payload) && "index" in payload ? payload.index : payload;
  if (!isRecord(candidate) || !Array.isArray(candidate.clusters) || !Array.isArray(candidate.points)) return null;
  return candidate as unknown as ForestIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
