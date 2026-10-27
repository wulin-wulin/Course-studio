import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, BookOpen, Check, GitBranch, LayoutGrid, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { unwrapCatalogGroups, unwrapCourses, type CourseCatalogGroup, type CourseSummary } from "./CourseCatalog";
import { CourseGroupGraph } from "./CourseGroupGraph";
import { relatedCourses, type CourseEdge, type CourseLayoutPosition } from "./catalogGraph";
import "./CourseGroupPage.css";

const API = "/api/courses/catalog";

async function readResponse(response: Response): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string" ? payload.detail : `请求失败（${response.status}）`;
    throw new Error(detail);
  }
  return payload;
}

function readGroup(payload: unknown): CourseCatalogGroup {
  const item = payload && typeof payload === "object" && "group" in payload ? payload.group : null;
  const group = unwrapCatalogGroups({ catalog: { groups: [item] } })?.[0];
  if (!group) throw new Error("课程大类数据格式无效");
  return group;
}

type Props = { groupId: string; onBack: () => void; onOpenCourse: (course: CourseSummary) => void };

export function CourseGroupPage({ groupId, onBack, onOpenCourse }: Props) {
  const [group, setGroup] = useState<CourseCatalogGroup | null>(null);
  const [groups, setGroups] = useState<CourseCatalogGroup[]>([]);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [view, setView] = useState<"cards" | "graph">("cards");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CourseEdge[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [placeholderOpen, setPlaceholderOpen] = useState(false);
  const [placeholderTitle, setPlaceholderTitle] = useState("");
  const [placeholderError, setPlaceholderError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const requestRef = useRef(0);
  const url = `${API}/groups/${encodeURIComponent(groupId)}`;

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [groupPayload, coursePayload, catalogPayload] = await Promise.all([
        fetch(url, { cache: "no-store" }).then(readResponse),
        fetch("/api/courses", { cache: "no-store" }).then(readResponse),
        fetch(API, { cache: "no-store" }).then(readResponse),
      ]);
      const nextGroup = readGroup(groupPayload);
      const nextCourses = unwrapCourses(coursePayload);
      const nextGroups = unwrapCatalogGroups(catalogPayload);
      if (!nextCourses || !nextGroups) throw new Error("课程目录格式无效");
      if (requestId !== requestRef.current) return;
      setGroup(nextGroup);
      setCourses(nextCourses);
      setGroups(nextGroups);
    } catch (failure) {
      if (requestId === requestRef.current) setError(failure instanceof Error ? failure.message : "课程加载失败");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
    const onChange = () => { void load(); };
    window.addEventListener("course-data-changed", onChange);
    return () => { requestRef.current++; window.removeEventListener("course-data-changed", onChange); };
  }, [load]);

  const groupCourses = (group?.course_ids ?? []).map((id) => courses.find((course) => course.id === id)).filter((course): course is CourseSummary => Boolean(course && !course.invalid));
  const unavailableCount = (group?.course_ids.length ?? 0) - groupCourses.length;
  const titleFor = (id: string) => courses.find((course) => course.id === id)?.title ?? id;

  const addEdge = (event: FormEvent) => {
    event.preventDefault();
    setEditorError(null);
    if (!fromId || !toId) return;
    if (fromId === toId) { setEditorError("先学和后学课程不能相同。"); return; }
    if (draft.some((edge) => edge.fromId === fromId && edge.toId === toId)) { setEditorError("这条先后关系已经存在。"); return; }
    if (relatedCourses(toId, draft, "after").has(fromId)) { setEditorError("这条关系会形成循环，请调整学习顺序。"); return; }
    setDraft((current) => [...current, { fromId, toId }]);
  };

  const saveEdges = async () => {
    setBusy(true);
    setEditorError(null);
    try {
      const payload = await fetch(`${url}/edges`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edges: draft }) }).then(readResponse);
      const savedGroup = readGroup(payload);
      setGroup(savedGroup);
      // Keep the catalogue snapshot used by the move-course confirmation in
      // sync with the graph that was just saved. Without this, moving a course
      // immediately after adding its first edge could silently skip the
      // relationship-removal warning.
      setGroups((current) => current.map((item) => item.id === savedGroup.id ? savedGroup : item));
      setEditing(false);
      setSavedNotice(true);
    } catch (failure) { setEditorError(failure instanceof Error ? failure.message : "关系保存失败"); }
    finally { setBusy(false); }
  };

  const saveLayout = async (positions: Record<string, CourseLayoutPosition>) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await fetch(`${url}/layout`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      }).then(readResponse);
      const savedGroup = readGroup(payload);
      setGroup(savedGroup);
      setGroups((current) => current.map((item) => item.id === savedGroup.id ? savedGroup : item));
      setSavedNotice(true);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "布局保存失败";
      setError(message);
      throw failure;
    } finally {
      setBusy(false);
    }
  };

  const createPlaceholder = async (event: FormEvent) => {
    event.preventDefault();
    const title = placeholderTitle.trim();
    if (!title) return;
    setBusy(true);
    setPlaceholderError(null);
    try {
      await fetch("/api/courses/placeholders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, group_id: groupId }),
      }).then(readResponse);
      setPlaceholderTitle("");
      setPlaceholderOpen(false);
      await load();
    } catch (failure) {
      setPlaceholderError(failure instanceof Error ? failure.message : "占位课程创建失败");
    } finally {
      setBusy(false);
    }
  };

  const assignCourse = async (courseId: string, targetId: string) => {
    const linked = groups.some((item) => item.edges.some((edge) => edge.fromId === courseId || edge.toId === courseId));
    if (linked && !window.confirm(`将“${titleFor(courseId)}”移入“${groups.find((item) => item.id === targetId)?.name}”？该课程在当前大类中的先后关系会被移除。`)) return;
    setBusy(true);
    setError(null);
    try {
      await fetch(`${API}/assignments`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ course_id: courseId, group_id: targetId }) }).then(readResponse);
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "课程归类失败"); }
    finally { setBusy(false); }
  };

  const openCourse = (course: CourseSummary) => {
    if (course.placeholder) {
      window.alert("该课程暂时没有内容，仅用于课程导览和图谱展示。\n如需正式课程，请删除后按原名称重新创建。");
      return;
    }
    onOpenCourse(course);
  };

  return <main className={`course-catalog course-group course-group--${view}`} aria-label="大类课程导览"><div className={`course-group__inner course-group__inner--${view}`}>
    <button type="button" className="course-group__back" onClick={onBack}><ArrowLeft size={16} />全部学科大类</button>
    <header className="course-group__hero"><p>学科大类 / 课程导览</p><h2>{group?.name ?? "课程导览"}</h2><span>从课程开始，循着先后关系走进知识森林。</span></header>
    <div className="course-group__toolbar">
      <div className="course-group__counts">{groupCourses.length} 门课程 <span>· {group?.edges.length ?? 0} 条先后关系</span></div>
      <div className="course-group__actions">
        <div className="course-group__view-switch" role="group" aria-label="课程展示方式">
          <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}><LayoutGrid size={15} />卡片视图</button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => setView("graph")}><GitBranch size={15} />图谱视图</button>
        </div>
        <button type="button" className="course-group__button" disabled={!group || busy || loading || editing} onClick={() => { setDraft(group?.edges ?? []); setEditorError(null); setSavedNotice(false); setEditing(true); }}><Pencil size={14} />编辑关系</button>
        <button type="button" className="course-group__button" disabled={!group || busy || loading || editing} onClick={() => { setPlaceholderError(null); setPlaceholderOpen((open) => !open); }}><Plus size={14} />添加占位课程</button>
        <button type="button" className="course-group__button" aria-label="刷新当前大类" disabled={loading || busy || editing} onClick={() => void load()}><RefreshCw size={15} className={loading ? "is-spinning" : ""} /></button>
      </div>
    </div>
    {placeholderOpen && <form className="course-group__placeholder-form" onSubmit={createPlaceholder} aria-label="添加占位课程">
      <div><strong>添加占位课程</strong><span>只填写课程名称，之后会直接出现在课程导览和图谱中。</span></div>
      <input value={placeholderTitle} onChange={(event) => setPlaceholderTitle(event.target.value)} maxLength={200} autoFocus placeholder="课程名称" aria-label="占位课程名称" disabled={busy} />
      <button type="submit" className="course-group__button course-group__button--primary" disabled={busy || !placeholderTitle.trim()}>{busy ? <Loader2 size={15} className="is-spinning" /> : <Plus size={15} />}添加</button>
      <button type="button" className="course-group__button" disabled={busy} onClick={() => { setPlaceholderOpen(false); setPlaceholderTitle(""); setPlaceholderError(null); }}>取消</button>
      {placeholderError && <p className="course-group__error" role="alert">{placeholderError}</p>}
    </form>}
    {error && <div className="course-group__error" role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => void load()} disabled={loading}>重试</button></div>}
    {savedNotice && <p className="course-group__notice" role="status"><Check size={15} />先后关系已保存，图谱已更新。</p>}
    {editing && <section className="course-group__editor" aria-label="编辑课程先后关系">
      <div className="course-group__editor-heading"><div><h3>编辑学习顺序</h3><p>设置单向关系：先学课程 → 后学课程。未设置关系的课程保持独立。</p></div><button type="button" aria-label="取消关系编辑" disabled={busy} onClick={() => setEditing(false)}><X size={18} /></button></div>
      <form onSubmit={addEdge} className="course-group__edge-form"><label>先学课程<select value={fromId} onChange={(event) => setFromId(event.target.value)} disabled={busy}><option value="">选择先学课程</option>{groupCourses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><ArrowRight size={19} /><label>后学课程<select value={toId} onChange={(event) => setToId(event.target.value)} disabled={busy}><option value="">选择后学课程</option>{groupCourses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><button type="submit" className="course-group__button" disabled={busy || !fromId || !toId}><Plus size={15} />添加关系</button></form>
      <ul className="course-group__edge-list" aria-label="待保存的先后关系">{draft.map((edge, index) => <li key={JSON.stringify([edge.fromId, edge.toId])}><span>{titleFor(edge.fromId)}</span><ArrowRight size={15} aria-label="先学到后学" /><span>{titleFor(edge.toId)}</span><button type="button" disabled={busy} aria-label={`删除${titleFor(edge.fromId)}到${titleFor(edge.toId)}的关系`} onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button></li>)}</ul>
      {draft.length === 0 && <p className="course-group__editor-empty">暂无先后关系。保存后，所有课程将在图谱中独立展示。</p>}
      {editorError && <p className="course-group__error" role="alert">{editorError}</p>}
      <div className="course-group__editor-footer"><span>{draft.length} 条关系 · 保存后生效</span><button type="button" className="course-group__button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button type="button" className="course-group__button course-group__button--primary" disabled={busy} onClick={() => void saveEdges()}>{busy ? <Loader2 size={15} className="is-spinning" /> : <Check size={15} />}保存关系</button></div>
    </section>}
    {loading && !group ? <div className="course-catalog__state" role="status"><Loader2 size={25} className="is-spinning" />正在加载课程…</div> : group && groupCourses.length === 0 ? <div className="course-catalog__state"><BookOpen size={28} /><strong>这个大类还没有可浏览的课程</strong><span>课程归入此大类后会显示在这里。</span></div> : group && view === "graph" ? <CourseGroupGraph courses={groupCourses} edges={group.edges} layout={group.layout} onSaveLayout={saveLayout} onOpenCourse={openCourse} /> : <ul className="course-catalog__shelf" aria-label={`${group?.name ?? "大类"}中的课程`}>{groupCourses.map((course) => <li key={course.id} className="course-catalog__course-item">
      <button type="button" className="course-catalog__card" onClick={() => openCourse(course)} aria-label={`进入${course.title}课程地图`}><span className="course-catalog__card-icon"><BookOpen size={21} /></span><span className="course-catalog__card-title">{course.title}</span><span className="course-catalog__card-description">{course.description?.trim() || "沿着知识路径，探索这门课程的知识森林。"}</span><span className="course-catalog__metrics">{course.clusters ?? "—"} 个知识簇 · {course.points ?? "—"} 个知识点</span><span className="course-catalog__enter">走进森林<ArrowRight size={16} /></span></button>
      <label className="course-catalog__assignment"><span>所属大类</span><select value={groupId} disabled={busy || editing} onChange={(event) => void assignCourse(course.id, event.target.value)} aria-label={`调整${course.title}所属大类`}>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </li>)}</ul>}
    {unavailableCount > 0 && <p className="course-group__notice" role="status"><AlertCircle size={15} />{unavailableCount} 门课程数据不可用，暂不能打开。</p>}
  </div></main>;
}
