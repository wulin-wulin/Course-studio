import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  FileText,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  parseTextbookDocument,
  uploadTextbookDocument,
  type TextbookDocumentMetadata,
} from "./api";
import {
  isSupportedPdfTextbookFile,
  isSupportedMarkdownTextbookFile,
  isSupportedTextbookFile,
  MARKDOWN_TEXTBOOK_FILE_ACCEPT,
  PDF_TEXTBOOK_FILE_ACCEPT,
  TEXTBOOK_FILE_ACCEPT,
} from "./setup";

type ProcessingPhase = "idle" | "uploading" | "parsing" | "ready" | "error";

type PdfCourseCreationFormProps = {
  disabled?: boolean;
  externalError?: string;
  acceptedFormat?: "all" | "pdf" | "markdown";
  onReady: (document: TextbookDocumentMetadata) => void;
  onCancel: () => void;
};

export function PdfCourseCreationForm({
  disabled = false,
  externalError = "",
  acceptedFormat = "all",
  onReady,
  onCancel,
}: PdfCourseCreationFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<TextbookDocumentMetadata | null>(null);
  const [phase, setPhase] = useState<ProcessingPhase>("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const processFile = useCallback(async (nextFile: File) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setFile(nextFile);
    setDocument(null);
    setError("");
    setPhase("uploading");
    try {
      const uploaded = await uploadTextbookDocument(nextFile, controller.signal);
      if (controller.signal.aborted) return;
      setDocument(uploaded);
      setPhase("parsing");
      const parsed = await parseTextbookDocument(
        uploaded.id,
        uploaded.filename,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const readyDocument = {
        ...uploaded,
        ...parsed,
        filename: parsed.filename || uploaded.filename,
        sizeBytes: parsed.sizeBytes ?? uploaded.sizeBytes ?? nextFile.size,
      };
      setDocument(readyDocument);
      setPhase("ready");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setError(reason instanceof Error ? reason.message : "教材处理失败，请重试");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [onReady]);

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    event.target.value = "";
    if (!nextFile) return;
    const supported = acceptedFormat === "markdown"
      ? isSupportedMarkdownTextbookFile(nextFile)
      : acceptedFormat === "pdf"
        ? isSupportedPdfTextbookFile(nextFile)
        : isSupportedTextbookFile(nextFile);
    if (!supported) {
      setFile(nextFile);
      setDocument(null);
      setPhase("error");
      setError(
        acceptedFormat === "markdown"
          ? "请选择 Markdown 格式的教材文件（.md、.markdown）"
          : acceptedFormat === "pdf"
            ? "请选择 PDF 格式的教材文件（.pdf）"
            : "请选择 PDF 或 Markdown 格式的教材文件（.pdf、.md）",
      );
      return;
    }
    if (nextFile.size <= 0) {
      setFile(nextFile);
      setDocument(null);
      setPhase("error");
      setError(
        acceptedFormat === "markdown"
          ? "教材文件为空，请选择有效的 Markdown 文件"
          : acceptedFormat === "pdf"
            ? "教材文件为空，请选择有效的 PDF 文件"
            : "教材文件为空，请选择有效的 PDF 或 Markdown 文件",
      );
      return;
    }
    void processFile(nextFile);
  };

  const reset = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setFile(null);
    setDocument(null);
    setPhase("idle");
    setError("");
  };

  const busy = phase === "uploading" || phase === "parsing";
  const progress = phase === "uploading" ? 38 : phase === "parsing" ? 76 : phase === "ready" ? 100 : 0;
  const visibleError = error || externalError;
  const summary = document?.outlineSummary;
  const markdownOnly = acceptedFormat === "markdown";
  const pdfOnly = acceptedFormat === "pdf";

  return (
    <section
      aria-live="polite"
      className="max-h-[min(58vh,560px)] overflow-y-auto rounded-2xl border border-primary/25 bg-gradient-to-b from-primary-light/80 to-surface shadow-md"
    >
      <div className="sticky top-0 z-10 flex items-start gap-2.5 border-b border-primary/15 bg-primary-light/95 px-3.5 py-3 backdrop-blur-sm">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-primary">
            {markdownOnly
              ? "从 Markdown 生成知识图谱"
              : pdfOnly
                ? "上传 PDF 生成知识森林"
                : "上传教材文件"}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">
            {markdownOnly
              ? "上传 MinerU 输出的 full.md 或结构化 Markdown，系统将读取章节、知识点和正文内容。"
              : pdfOnly
                ? "上传 PDF 后，系统将调用 MinerU 生成 full.md，再生成章节、知识图谱和知识森林。"
                : "支持 PDF 与 Markdown，系统将读取教材结构和正文内容来创建课程。"}
          </div>
        </div>
      </div>

      <div className="space-y-3 p-3.5">
        {!file ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            className="grid min-h-32 w-full place-items-center content-center gap-2 rounded-xl border border-dashed border-primary/35 bg-surface/80 px-4 py-5 text-center transition-colors hover:border-primary/60 hover:bg-primary-light/45 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-light text-primary">
              <Upload className="h-5 w-5" />
            </span>
            <strong className="text-xs text-text-primary">
              {markdownOnly
                ? "选择 Markdown 教材"
                : pdfOnly
                  ? "选择 PDF 教材"
                  : "选择 PDF 或 Markdown 教材"}
            </strong>
            <span className="text-[11px] text-text-secondary">选择后会自动上传并解析</span>
          </button>
        ) : (
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="flex items-start gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-light text-primary">
                <FileText className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-xs text-text-primary">
                  {document?.filename || file.name}
                </strong>
                <span className="mt-0.5 block text-[11px] text-text-secondary">
                  {formatFileSize(document?.sizeBytes ?? file.size)}
                </span>
              </div>
              {!busy && (
                <button
                  type="button"
                  onClick={reset}
                  disabled={disabled}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-cream hover:text-text-primary disabled:opacity-50"
                  title="移除教材"
                  aria-label="移除教材"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {phase !== "error" && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="inline-flex items-center gap-1.5 font-medium text-primary">
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    {phaseLabel(phase, markdownOnly || pdfOnly)}
                  </span>
                  <span className="text-text-secondary">{progress}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cream-dark">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "ready" && document && (
          <div className="rounded-xl border border-primary/20 bg-primary-light/55 p-3">
            <div className="flex items-start gap-2">
              <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <strong className="block text-xs text-text-primary">
                  {markdownOnly
                    ? "Markdown 教材解析完成"
                    : pdfOnly
                      ? "PDF 教材解析完成"
                      : "教材结构解析完成"}
                </strong>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  {formatOutlineSummary(summary)}
                </p>
              </div>
            </div>
          </div>
        )}

        {visibleError && (
          <div className="flex items-start gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs text-error">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{visibleError}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-cream hover:text-text-primary disabled:opacity-50"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            {phase === "error" && file && (
              <button
                type="button"
                onClick={() => void processFile(file)}
                disabled={disabled}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/25 bg-surface px-3 text-xs font-semibold text-primary hover:bg-primary-light disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重试
              </button>
            )}
            {phase === "ready" && document && (
              <button
                type="button"
                onClick={() => onReady(document)}
                disabled={disabled}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
              >
                <BookOpenCheck className="h-3.5 w-3.5" />
                {markdownOnly || pdfOnly ? "开始生成知识图谱" : "使用此教材创建"}
              </button>
            )}
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={
            markdownOnly
              ? MARKDOWN_TEXTBOOK_FILE_ACCEPT
              : pdfOnly
                ? PDF_TEXTBOOK_FILE_ACCEPT
                : TEXTBOOK_FILE_ACCEPT
          }
          onChange={chooseFile}
          className="hidden"
        />
      </div>
    </section>
  );
}

function phaseLabel(phase: ProcessingPhase, markdownOnly = false) {
  switch (phase) {
    case "uploading":
      return "正在上传教材";
    case "parsing":
      return "正在整理教材结构与正文材料";
    case "ready":
      return markdownOnly
        ? "解析完成，请确认后生成知识图谱"
        : "解析完成，请确认后开始课程创建";
    case "error":
      return "处理失败";
    default:
      return "等待选择教材";
  }
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "文件大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatOutlineSummary(summary: TextbookDocumentMetadata["outlineSummary"]) {
  if (!summary) return "章节与知识点范围已经就绪，即将进入结构审核和内容扩充流程。";
  const metrics = [
    typeof summary.chapterCount === "number" ? `${summary.chapterCount} 个章节` : "",
    typeof summary.knowledgePointCount === "number"
      ? `${summary.knowledgePointCount} 个知识点`
      : "",
  ].filter(Boolean);
  const prefix = summary.title ? `《${summary.title}》` : "";
  return `${prefix}${metrics.length > 0 ? `${prefix ? " · " : ""}${metrics.join(" · ")}` : "教材纲要已就绪"}`;
}
