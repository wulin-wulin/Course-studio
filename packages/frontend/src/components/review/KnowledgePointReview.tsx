import { useMemo, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  PointReviewOperation,
  ReviewResource,
} from "@/features/reviews/types";

type Props = {
  review: ReviewResource;
  disabled: boolean;
  readOnly: boolean;
  submitting: boolean;
  submitError: string;
  onSubmit: (operations: PointReviewOperation[]) => void;
};

const POINT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function KnowledgePointReview({
  review,
  disabled,
  readOnly,
  submitting,
  submitError,
  onSubmit,
}: Props) {
  const [query, setQuery] = useState("");
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Array<{ id: string; title: string }>>([]);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [formError, setFormError] = useState("");
  const originalIds = useMemo(
    () => new Set(review.points.map((point) => point.id)),
    [review.points],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible = useMemo(
    () =>
      normalizedQuery
        ? review.points.filter((point) =>
            [point.id, point.title, ...point.keyTerms].some((value) =>
              value.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
            ),
          )
        : review.points,
    [normalizedQuery, review.points],
  );
  const operations: PointReviewOperation[] = [
    ...review.points.flatMap((point): PointReviewOperation[] =>
      deletedIds.has(point.id) ? [{ op: "delete", point_id: point.id }] : [],
    ),
    ...added.map((point): PointReviewOperation => ({ op: "add", point })),
  ];
  const finalCount = review.points.length - deletedIds.size + added.length;

  const addPoint = (event: FormEvent) => {
    event.preventDefault();
    const id = newId.trim();
    const title = newTitle.trim();
    if (!POINT_ID_PATTERN.test(id)) {
      setFormError("ID 只能使用小写英文、数字和连字符");
      return;
    }
    if (!title || title.length > 160) {
      setFormError("名称长度应为 1 至 160 个字符");
      return;
    }
    if (originalIds.has(id) || added.some((point) => point.id === id)) {
      setFormError("这个知识点 ID 已存在");
      return;
    }
    setAdded((current) => [...current, { id, title }]);
    setNewId("");
    setNewTitle("");
    setFormError("");
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-28 pt-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">完整知识点清单</h2>
          <p className="mt-1 text-sm text-text-secondary">
            最终 {finalCount} 个 · 删除 {deletedIds.size} 个 · 新增 {added.length} 个
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">搜索知识点</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、ID 或关键词"
            className="h-10 w-full rounded-md border border-border bg-surface pl-9 pr-9 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-text-secondary hover:bg-cream-dark"
              aria-label="清除搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>

      <div className="mt-4 space-y-2">
        {visible.map((point, index) => {
          const deleted = deletedIds.has(point.id);
          const issueCount =
            point.issues.length +
            review.review_queue.filter((issue) => issue.pointId === point.id).length;
          return (
            <article
              key={point.id}
              className={`flex items-start gap-3 rounded-lg border p-4 ${
                deleted
                  ? "border-error/25 bg-error/5"
                  : issueCount
                    ? "border-warning/35 bg-surface"
                    : "border-border bg-surface"
              }`}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary-light text-xs font-semibold text-primary">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong
                    className={`text-sm ${
                      deleted ? "text-text-secondary line-through" : "text-text-primary"
                    }`}
                  >
                    {point.title}
                  </strong>
                  <code className="text-[11px] text-text-secondary">{point.id}</code>
                  {issueCount > 0 && !deleted && (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                      {issueCount} 项待复核
                    </span>
                  )}
                </div>
                {point.shortSummary && (
                  <p className="mt-1.5 text-xs leading-5 text-text-secondary">
                    {point.shortSummary}
                  </p>
                )}
                {point.keyTerms.length > 0 && (
                  <p className="mt-2 text-[11px] text-text-secondary">
                    关键词：{point.keyTerms.join("、")}
                  </p>
                )}
              </div>
              {!readOnly && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setDeletedIds((current) => {
                      const next = new Set(current);
                      if (next.has(point.id)) next.delete(point.id);
                      else next.add(point.id);
                      return next;
                    })
                  }
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border disabled:opacity-45 ${
                    deleted
                      ? "border-primary/25 bg-primary-light text-primary"
                      : "border-border text-text-secondary hover:border-error/30 hover:text-error"
                  }`}
                  aria-label={`${deleted ? "恢复" : "删除"}${point.title}`}
                >
                  {deleted ? <RotateCcw className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                </button>
              )}
            </article>
          );
        })}
        {visible.length === 0 && (
          <div className="grid min-h-28 place-items-center rounded-lg border border-dashed border-border bg-surface text-sm text-text-secondary">
            没有匹配的知识点
          </div>
        )}
      </div>

      {added.length > 0 && (
        <section className="mt-6 space-y-2" aria-label="待新增知识点">
          <h3 className="text-sm font-semibold text-text-primary">待新增知识点</h3>
          {added.map((point) => (
            <div
              key={point.id}
              className="flex items-center gap-3 rounded-lg border border-primary/25 bg-primary-light/45 px-4 py-3"
            >
              <Plus className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{point.title}</strong>
                <code className="text-[11px] text-text-secondary">{point.id}</code>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() =>
                    setAdded((current) => current.filter((item) => item.id !== point.id))
                  }
                  className="grid h-8 w-8 place-items-center text-text-secondary hover:text-error"
                  aria-label={`取消新增${point.title}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {!readOnly && (
        <form
          onSubmit={addPoint}
          className="mt-7 grid gap-3 border-t border-border pt-5 sm:grid-cols-[0.8fr_1.2fr_auto] sm:items-end"
        >
          <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
            知识点 ID
            <input
              value={newId}
              onChange={(event) => {
                setNewId(event.target.value);
                setFormError("");
              }}
              disabled={disabled}
              placeholder="gradient-descent"
              className="h-10 rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
            知识点名称
            <input
              value={newTitle}
              onChange={(event) => {
                setNewTitle(event.target.value);
                setFormError("");
              }}
              disabled={disabled}
              placeholder="梯度下降"
              className="h-10 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <button
            type="submit"
            disabled={disabled || !newId.trim() || !newTitle.trim()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary/30 px-4 text-sm font-semibold text-primary hover:bg-primary-light disabled:opacity-45"
          >
            <Plus className="h-4 w-4" />
            添加
          </button>
          {formError && (
            <p className="text-xs text-error sm:col-span-3" role="alert">
              {formError}
            </p>
          )}
        </form>
      )}

      <footer className="sticky bottom-0 z-20 -mx-4 mt-7 border-t border-border bg-surface/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.05)] backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-text-secondary">
            {readOnly
              ? "该审核已完成"
              : operations.length === 0
                ? "不修改，直接通过当前知识点清单"
                : `将提交 ${operations.length} 项变更`}
          </span>
          <button
            type="button"
            onClick={() => onSubmit(operations)}
            disabled={disabled || readOnly || finalCount < 1}
            className="inline-flex h-10 min-w-44 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {submitting
              ? "正在提交"
              : operations.length === 0
                ? "一键通过并继续"
                : "确认变更并继续"}
          </button>
          {(submitError || finalCount < 1) && (
            <p className="w-full text-right text-xs text-error" role="alert">
              {submitError || "至少保留或新增一个知识点"}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}
