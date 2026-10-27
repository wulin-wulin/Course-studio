import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize, Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import type { CourseSummary } from "./CourseCatalog";
import { layoutCourses, relatedCourses, validEdges, type CourseEdge, type CourseGroupLayout, type CourseLayoutPosition, type MapPosition } from "./catalogGraph";

type Props = {
  courses: CourseSummary[];
  edges: CourseEdge[];
  layout?: CourseGroupLayout;
  onOpenCourse?: (course: CourseSummary) => void;
  onSaveLayout?: (positions: Record<string, CourseLayoutPosition>) => Promise<void>;
};

const NODE_COLORS = ["#d98958", "#c95c57", "#4d6982", "#52a89c", "#5b9bc0", "#d59a55"];

export function CourseGroupGraph({ courses, edges: rawEdges, layout: savedLayout, onOpenCourse, onSaveLayout }: Props) {
  const markerId = useId().replace(/:/g, "");
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const nodeDragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 900, height: 560, mapWidth: 1150 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editingLayout, setEditingLayout] = useState(false);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const ids = useMemo(() => courses.map((course) => course.id), [courses]);
  const edges = useMemo(() => validEdges(ids, rawEdges), [ids, rawEdges]);
  const [manualPositions, setManualPositions] = useState<Record<string, CourseLayoutPosition>>(() => savedLayout?.positions ?? {});
  const savedPositionKey = useMemo(() => JSON.stringify(savedLayout?.positions ?? {}), [savedLayout]);
  useEffect(() => {
    setManualPositions(savedLayout?.positions ?? {});
    setLayoutDirty(false);
  }, [savedPositionKey, ids.join(",")]);
  const compact = canvasSize.width < 940;
  const independentColumns = canvasSize.width < 500 ? 1 : compact ? 2 : 3;
  useEffect(() => {
    if (compact) setEditingLayout(false);
  }, [compact]);
  const layout = useMemo(() => layoutCourses(ids, edges, {
    availableWidth: canvasSize.width,
    compact,
    independentColumns,
    flexible: true,
    manualPositions,
  }), [ids, edges, canvasSize.width, compact, independentColumns, manualPositions]);
  const before = useMemo(() => selectedId ? relatedCourses(selectedId, edges, "before") : new Set<string>(), [selectedId, edges]);
  const after = useMemo(() => selectedId ? relatedCourses(selectedId, edges, "after") : new Set<string>(), [selectedId, edges]);
  const stacked = canvasSize.mapWidth <= 850;
  const adaptiveCanvasHeight = stacked ? Math.max(canvasSize.width < 500 ? 520 : 490, layout.height + 18) : undefined;

  const svgPoint = (clientX: number, clientY: number) => {
    const matrix = svgRef.current?.getScreenCTM();
    return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : new DOMPoint();
  };
  const graphPoint = (clientX: number, clientY: number): MapPosition => {
    const point = svgPoint(clientX, clientY);
    return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
  };
  const zoomAt = (factor: number, point: { x: number; y: number }) => {
    setViewport((current) => {
      const zoom = Math.max(0.35, Math.min(4, current.zoom * factor));
      const ratio = zoom / current.zoom;
      return { zoom, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio };
    });
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;
    const measure = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const mapRect = map.getBoundingClientRect();
      const next = {
        width: Math.max(320, Math.round(canvasRect.width)),
        height: Math.max(400, Math.round(canvasRect.height)),
        mapWidth: Math.round(mapRect.width),
      };
      setCanvasSize((current) => current.width === next.width && current.height === next.height && current.mapWidth === next.mapWidth ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(map);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setViewport({ x: 0, y: 0, zoom: 1 });
  }, [independentColumns]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0015), svgPoint(event.clientX, event.clientY));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === mapRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);
  const toggleFullscreen = async () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (document.fullscreenElement === map) {
        await document.exitFullscreen();
      } else if (map.requestFullscreen) {
        await map.requestFullscreen();
      }
    } catch {
      // Browser policies can reject fullscreen without affecting the graph.
    }
  };

  return (
    <div ref={mapRef} className="course-map">
      <div ref={canvasRef} className="course-map__canvas" style={adaptiveCanvasHeight ? { height: `${adaptiveCanvasHeight}px` } : undefined}>
        <div className="course-map__caption"><span className="course-map__caption-kicker">VECTOR</span><span className="course-map__caption-label">关系保留</span></div>
        <div className="course-map__stats">{courses.length} 节点与边保持一致</div>
        <div className="course-map__layout-tools" role="group" aria-label="图谱布局工具">
          <button type="button" className={editingLayout ? "is-active" : ""} aria-pressed={editingLayout} disabled={compact} title={compact ? "请在较宽的图谱区域中调整节点" : undefined} onClick={() => setEditingLayout((current) => !current)}>{editingLayout ? "完成调整" : "调整位置"}</button>
          {editingLayout && <>
            <button type="button" onClick={() => { setManualPositions({}); setLayoutDirty(true); }}>自动整理</button>
            <button type="button" className="is-primary" disabled={!layoutDirty || savingLayout} onClick={() => {
              if (!onSaveLayout) { setLayoutDirty(false); setEditingLayout(false); return; }
              setSavingLayout(true);
              void onSaveLayout(manualPositions).then(() => { setLayoutDirty(false); setEditingLayout(false); }).catch(() => undefined).finally(() => setSavingLayout(false));
            }}>{savingLayout ? "保存中…" : "保存布局"}</button>
          </>}
        </div>
        <svg
          ref={svgRef}
          className="course-map__svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-label="课程先后关系图谱，可拖动平移、滚轮缩放，点击课程进入对应课程"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const node = (event.target as Element).closest("[data-course-node]");
            if (editingLayout && node) {
              const id = node.getAttribute("data-course-id");
              if (!id) return;
              nodeDragRef.current = { id, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.stopPropagation();
              return;
            }
            if (node) return;
            const point = svgPoint(event.clientX, event.clientY);
            dragRef.current = { x: point.x, y: point.y, panX: viewport.x, panY: viewport.y, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const nodeDrag = nodeDragRef.current;
            if (nodeDrag) {
              const point = graphPoint(event.clientX, event.clientY);
              const current = manualPositions[nodeDrag.id];
              const previous = current ?? layout.positions.get(nodeDrag.id) ?? point;
              if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) > 3) nodeDrag.moved = true;
              setManualPositions((positions) => ({ ...positions, [nodeDrag.id]: { x: point.x, y: point.y, pinned: true } }));
              setLayoutDirty(true);
              return;
            }
            const drag = dragRef.current;
            if (!drag) return;
            const point = svgPoint(event.clientX, event.clientY);
            if (Math.abs(point.x - drag.x) + Math.abs(point.y - drag.y) > 4) drag.moved = true;
            setViewport((current) => ({ ...current, x: drag.panX + point.x - drag.x, y: drag.panY + point.y - drag.y }));
          }}
          onPointerUp={(event) => {
            if (nodeDragRef.current) {
              suppressClickRef.current = nodeDragRef.current.moved;
              nodeDragRef.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              return;
            }
            if (dragRef.current && !dragRef.current.moved) setSelectedId(null);
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { dragRef.current = null; nodeDragRef.current = null; }}
        >
          <defs>
            <marker id={`${markerId}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 9 4.5 L 0 9 z" fill="currentColor" /></marker>
            <marker id={`${markerId}-active`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker>
          </defs>
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            {layout.independentStart !== null && <text x="60" y={layout.independentStart - 44} className="course-map__section-label">独立课程 · 暂未设置关系</text>}
            {edges.map((edge) => {
              const source = layout.positions.get(edge.fromId)!;
              const target = layout.positions.get(edge.toId)!;
              const upstream = (edge.fromId === selectedId || before.has(edge.fromId)) && (edge.toId === selectedId || before.has(edge.toId));
              const downstream = (edge.fromId === selectedId || after.has(edge.fromId)) && (edge.toId === selectedId || after.has(edge.toId));
              const active = Boolean(selectedId && (upstream || downstream));
              const vertical = layout.orientation === "vertical";
              const direction = target.x >= source.x ? 1 : -1;
              const sx = vertical ? source.x : source.x + direction * 16;
              const sy = vertical ? source.y + 18 : source.y;
              const tx = vertical ? target.x : target.x - direction * 20;
              const ty = vertical ? target.y - 20 : target.y;
              const bend = Math.max(48, Math.abs((vertical ? ty - sy : tx - sx)) * 0.45);
              const path = vertical
                ? `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`
                : `M ${sx} ${sy} C ${sx + bend * direction} ${sy}, ${tx - bend * direction} ${ty}, ${tx} ${ty}`;
              const sourceIndex = courses.findIndex((course) => course.id === edge.fromId);
              return <path key={JSON.stringify([edge.fromId, edge.toId])} d={path} style={{ color: active ? "#d78935" : NODE_COLORS[sourceIndex % NODE_COLORS.length] }} className={`course-map__edge ${active ? "is-active" : selectedId ? "is-dimmed" : ""}`} markerEnd={`url(#${markerId}-${active ? "active" : "arrow"})`} />;
            })}
            {courses.map((course, index) => {
              const point = layout.positions.get(course.id)!;
              const isSelected = selectedId === course.id;
              const related = before.has(course.id) || after.has(course.id);
              const incoming = edges.filter((edge) => edge.toId === course.id).length;
              const outgoing = edges.filter((edge) => edge.fromId === course.id).length;
              const radius = Math.min(18, 10 + Math.min(4, incoming + outgoing));
              const labelOnRight = point.x < layout.width * 0.58;
              const labelX = labelOnRight ? radius + 18 : -(radius + 18);
              const anchor = labelOnRight ? "start" : "end";
              const labelLimit = compact ? 12 : 18;
              const visibleTitle = course.title.length > labelLimit ? `${course.title.slice(0, labelLimit - 1)}…` : course.title;
              const labelWidth = Math.max(72, Math.min(220, [...visibleTitle].length * 12 + 18));
              const labelRectX = labelOnRight ? radius + 8 : -(radius + 8 + labelWidth);
              return <g key={course.id} data-course-node="true" data-course-id={course.id} transform={`translate(${point.x} ${point.y})`} style={{ color: NODE_COLORS[index % NODE_COLORS.length] }} role="button" tabIndex={0} aria-label={`${editingLayout ? "移动" : course.placeholder ? "打开" : "进入"}${course.title}课程节点`} aria-pressed={isSelected} className={`course-map__node ${editingLayout ? "is-layout-editing" : ""} ${manualPositions[course.id]?.pinned === true ? "is-pinned" : ""} ${isSelected ? "is-selected" : related ? "is-related" : selectedId ? "is-dimmed" : ""}`} onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } if (editingLayout) { setSelectedId(course.id); return; } if (onOpenCourse) { onOpenCourse(course); return; } setSelectedId(course.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (editingLayout) { setSelectedId(course.id); return; } if (onOpenCourse) { onOpenCourse(course); return; } setSelectedId(course.id); } }}>
                <title>{course.title}</title>
                <circle className="course-map__halo" r={radius + 9} />
                <circle className="course-map__core" r={isSelected ? radius + 3 : radius} />
                <rect className="course-map__label-bg" x={labelRectX} y="-13" width={labelWidth} height="26" rx="7" />
                <text className="course-map__label" x={labelX} y="4" textAnchor={anchor}>{visibleTitle}</text>
              </g>;
            })}
          </g>
        </svg>
        <div className="course-map__tools">
          <button type="button" aria-label="缩小图谱" title="缩小" onClick={() => zoomAt(0.8, { x: canvasSize.width / 2, y: canvasSize.height / 2 })}><Minus size={16} /></button>
          <span>{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" aria-label="放大图谱" title="放大" onClick={() => zoomAt(1.25, { x: canvasSize.width / 2, y: canvasSize.height / 2 })}><Plus size={16} /></button>
          <button type="button" aria-label="重置图谱视图" title="重置视图" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}><Maximize size={16} /></button>
          <button type="button" aria-label={isFullscreen ? "退出全屏图谱" : "全屏查看图谱"} title={isFullscreen ? "退出全屏" : "全屏查看"} onClick={() => void toggleFullscreen()}>{isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        </div>
        <p className="course-map__hint">{editingLayout ? "拖动节点调整位置 · 算法会自动避让 · 保存后下次继续使用" : "拖动平移 · 滚轮缩放 · 点击课程进入详情"}{edges.length === 0 ? " · 尚未设置先后关系" : " · 箭头指向后学课程"}</p>
      </div>
    </div>
  );
}
