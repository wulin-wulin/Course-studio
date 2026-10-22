import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  ArrowLeft,
  BookOpen,
  ListOrdered,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import { buildSceneInputs, normalizeForestIndex } from "@/course/forest/forestAdapter";
import type {
  CourseDataChangedDetail,
  CourseMeta,
  ForestIndex,
  ForestPoint,
  ForestSequences,
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
  setSequenceEdges: (sequences: ForestSequences) => void;
  clearSequenceEdges: () => void;
  dispose: () => void;
};

type CourseForestViewportProps = {
  course: CourseMeta;
  onOpenPoint: (point: ForestPoint) => void;
  onBackToCatalog: () => void;
};

type SequenceLayer = "cluster" | "point";

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
  const [showSequences, setShowSequences] = useState(false);
  const [sequenceLayer, setSequenceLayer] = useState<SequenceLayer>("cluster");
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
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
      const nextIndex = normalizeForestIndex(payload);
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
    setShowSequences(false);
    setSequenceLayer("cluster");
    setFocusedClusterId(null);
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

  const originCounts = useMemo(() => {
    const result = { textbook: 0, extension: 0 };
    for (const point of index?.points ?? []) {
      if (point.origin === "textbook") result.textbook += 1;
      if (point.origin === "llm-extension") result.extension += 1;
    }
    return result;
  }, [index]);
  const hasOriginLegend = originCounts.textbook + originCounts.extension > 0;

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

  const sequenceCounts = useMemo(() => ({
    cluster: index?.sequences?.cluster.length ?? 0,
    point: index?.sequences?.point.length ?? 0,
  }), [index]);
  const sequenceCount = sequenceCounts.cluster + sequenceCounts.point;
  const pointClusterById = useMemo(() => (
    new Map((index?.points ?? []).map((point) => [point.id, point.clusterId]))
  ), [index]);
  const focusedPointSequences = useMemo(() => {
    if (!focusedClusterId || !index?.sequences) return [];
    return index.sequences.point.filter((edge) => (
      pointClusterById.get(edge.fromId) === focusedClusterId
      && pointClusterById.get(edge.toId) === focusedClusterId
    ));
  }, [focusedClusterId, index, pointClusterById]);
  const firstClusterWithPointSequence = useMemo(() => {
    for (const edge of index?.sequences?.point ?? []) {
      const fromClusterId = pointClusterById.get(edge.fromId);
      if (fromClusterId && fromClusterId === pointClusterById.get(edge.toId)) {
        return fromClusterId;
      }
    }
    return null;
  }, [index, pointClusterById]);
  const displayedSequences = useMemo<ForestSequences | null>(() => {
    if (!showSequences || !index?.sequences) return null;
    if (sequenceLayer === "cluster") {
      return { cluster: index.sequences.cluster, point: [] };
    }
    return { cluster: [], point: focusedPointSequences };
  }, [focusedPointSequences, index, sequenceLayer, showSequences]);
  const displayedSequenceCount = sequenceLayer === "cluster"
    ? sequenceCounts.cluster
    : focusedPointSequences.length;
  const focusedClusterTitle = focusedClusterId
    ? clusterById.get(focusedClusterId) ?? null
    : null;
  const hasForestData = Boolean(index && index.clusters.length > 0 && index.points.length > 0);

  useEffect(() => {
    if (sequenceCount > 0) return;
    setShowSequences(false);
    setSequenceLayer("cluster");
  }, [sequenceCount]);

  useEffect(() => {
    if (!focusedClusterId || clusterById.has(focusedClusterId)) return;
    setFocusedClusterId(null);
    setSequenceLayer("cluster");
  }, [clusterById, focusedClusterId]);

  useEffect(() => {
    if (!showSequences) return;
    if (sequenceLayer === "cluster") {
      if (sequenceCounts.cluster === 0) setShowSequences(false);
      return;
    }
    if (focusedPointSequences.length > 0) return;
    if (sequenceCounts.cluster > 0) setSequenceLayer("cluster");
    else setShowSequences(false);
  }, [focusedPointSequences.length, sequenceCounts.cluster, sequenceLayer, showSequences]);

  const focusCluster = useCallback((clusterId: string) => {
    setFocusedClusterId(clusterId);
    sceneRef.current?.flyToCluster(clusterId);
    if (showSequences) {
      const hasPointSequence = index?.sequences?.point.some((edge) => (
        pointClusterById.get(edge.fromId) === clusterId
        && pointClusterById.get(edge.toId) === clusterId
      ));
      if (hasPointSequence) setSequenceLayer("point");
      else if (sequenceCounts.cluster > 0) setSequenceLayer("cluster");
      else setShowSequences(false);
    }
  }, [index, pointClusterById, sequenceCounts.cluster, showSequences]);

  const toggleSequences = useCallback(() => {
    if (showSequences) {
      setShowSequences(false);
      return;
    }
    setShowSequences(true);
    if (sequenceCounts.cluster > 0) {
      setSequenceLayer("cluster");
    } else if (focusedPointSequences.length > 0) {
      setSequenceLayer("point");
    } else if (firstClusterWithPointSequence) {
      setFocusedClusterId(firstClusterWithPointSequence);
      setSequenceLayer("point");
      sceneRef.current?.flyToCluster(firstClusterWithPointSequence);
    }
  }, [firstClusterWithPointSequence, focusedPointSequences.length, sequenceCounts.cluster, showSequences]);

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
            if (clusterId) focusCluster(clusterId);
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
          className={`course-forest__sequence-toggle${showSequences ? " is-active" : ""}`}
          onClick={toggleSequences}
          disabled={sequenceCount === 0 || !hasForestData}
          aria-pressed={showSequences}
          title={sequenceCount > 0
            ? showSequences
              ? `隐藏当前顺序（${displayedSequenceCount} 条）`
              : `显示学习顺序（${sequenceCount} 条可用）`
            : "当前课程暂无学习顺序"}
        >
          <ListOrdered aria-hidden="true" size={16} />
          <span>
            {showSequences
              ? sequenceLayer === "cluster" ? "簇顺序" : "本簇顺序"
              : "学习顺序"}
          </span>
        </button>

        <button
          type="button"
          className="course-forest__icon-button"
          onClick={() => {
            setFocusedClusterId(null);
            if (sequenceCounts.cluster > 0) setSequenceLayer("cluster");
            else setShowSequences(false);
            sceneRef.current?.resetView();
          }}
          title="重置视图"
          aria-label="重置视图"
        >
          <RotateCcw aria-hidden="true" size={16} />
        </button>
      </div>

      {index && hasForestData && (
        <ForestScene
          index={index}
          sceneRef={sceneRef}
          sequences={displayedSequences}
          onPointClick={openPoint}
        />
      )}

      {isLoading && !index && <ForestLoading />}
      {loadError && !index && <ForestError message={loadError} onRetry={() => void loadIndex()} />}
      {index && !hasForestData && <ForestEmpty index={index} />}
      {isRefreshing && index && (
        <div className="course-forest__syncing" role="status">
          <Loader2 aria-hidden="true" size={14} />
          正在同步课程数据
        </div>
      )}

      {index && hasForestData && !legendHidden && (
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
                className={focusedClusterId === cluster.id ? "is-focused" : undefined}
                aria-pressed={focusedClusterId === cluster.id}
                onClick={() => focusCluster(cluster.id)}
              >
                <i style={{ backgroundColor: cluster.accent }} aria-hidden="true" />
                <span>{cluster.title}</span>
                <small>{pointCountByCluster.get(cluster.id) ?? 0}</small>
              </button>
            ))}
          </div>
          {hasOriginLegend && (
            <div className="course-forest__origin-legend" aria-label="知识点来源图例">
              <strong>知识点来源</strong>
              {originCounts.textbook > 0 && (
                <span>
                  <i className="is-textbook" aria-hidden="true" />
                  教材原有 <small>{originCounts.textbook}</small>
                </span>
              )}
              {originCounts.extension > 0 && (
                <span>
                  <i className="is-extension" aria-hidden="true" />
                  模型扩展 <small>{originCounts.extension}</small>
                </span>
              )}
            </div>
          )}
        </aside>
      )}

      {index && hasForestData && legendHidden && (
        <button type="button" className="course-forest__legend-restore" onClick={() => setLegendHidden(false)}>
          显示知识簇
        </button>
      )}

      {index && hasForestData && showSequences && sequenceCount > 0 && (
        <aside className="course-forest__sequence-legend" aria-label="学习顺序图例">
          <strong>学习顺序</strong>
          <div className="course-forest__sequence-scope" role="group" aria-label="顺序显示层级">
            <button
              type="button"
              className={sequenceLayer === "cluster" ? "is-active" : undefined}
              disabled={sequenceCounts.cluster === 0}
              aria-pressed={sequenceLayer === "cluster"}
              onClick={() => setSequenceLayer("cluster")}
            >
              知识簇
            </button>
            <button
              type="button"
              className={sequenceLayer === "point" ? "is-active" : undefined}
              disabled={!focusedClusterId || focusedPointSequences.length === 0}
              aria-pressed={sequenceLayer === "point"}
              onClick={() => setSequenceLayer("point")}
              title={!focusedClusterId
                ? "请先定位一个知识簇"
                : focusedPointSequences.length === 0
                  ? "当前知识簇没有知识点顺序"
                  : `显示${focusedClusterTitle ?? "当前知识簇"}的知识点顺序`}
            >
              本簇知识点
            </button>
          </div>
          <p>
            {sequenceLayer === "cluster"
              ? "总览只显示知识簇之间的先后关系"
              : focusedClusterTitle
                ? `当前：${focusedClusterTitle}`
                : "请先定位一个知识簇"}
          </p>
          <span>
            <i className={sequenceLayer === "cluster" ? "is-cluster" : "is-point"} aria-hidden="true" />
            {sequenceLayer === "cluster" ? "知识簇" : "知识点"} {displayedSequenceCount}
          </span>
        </aside>
      )}
    </section>
  );
}

function ForestScene({
  index,
  sceneRef,
  sequences,
  onPointClick,
}: {
  index: ForestIndex;
  sceneRef: MutableRefObject<SceneHandle | null>;
  sequences: ForestSequences | null;
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

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (sequences && (sequences.cluster.length > 0 || sequences.point.length > 0)) {
      scene.setSequenceEdges(sequences);
    } else {
      scene.clearSequenceEdges();
    }
  }, [sceneRef, sequences]);

  return <div ref={containerRef} className="course-forest__canvas" aria-label="可交互的知识森林地图" />;
}

function ForestLoading() {
  return (
    <div className="course-forest__state" role="status">
      <Loader2 aria-hidden="true" size={26} className="course-forest__spinner" />
      <span>正在加载知识森林…</span>
    </div>
  );
}

function ForestEmpty({ index }: { index: ForestIndex }) {
  const missing = index.clusters.length === 0 ? "知识簇" : "知识点";
  return (
    <div className="course-forest__state" role="status">
      <BookOpen aria-hidden="true" size={26} />
      <strong>这门课程还没有可展示的知识森林</strong>
      <span>课程索引中缺少{missing}，请重新生成或检查发布结果。</span>
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
