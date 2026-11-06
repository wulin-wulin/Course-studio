import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  FileCheck2,
  FileText,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  parseCurriculumDocument,
  parseTextbookDocument,
  uploadCurriculumDocument,
  uploadTextbookDocument,
  type CurriculumDocumentMetadata,
  type TextbookDocumentMetadata,
} from "./api";
import {
  CURRICULUM_FILE_ACCEPT,
  isSupportedCurriculumFile,
  isSupportedTextbookFile,
  TEXTBOOK_FILE_ACCEPT,
} from "./setup";

type ProcessingPhase = "idle" | "uploading" | "parsing" | "ready" | "error";

type CommonDocumentMetadata = {
  id: string;
  filename: string;
  sizeBytes?: number;
};

type SourceUploadCardProps<Document extends CommonDocumentMetadata> = {
  title: string;
  description: string;
  chooseLabel: string;
  parsingLabel: string;
  accept: string;
  emptyError: string;
  unsupportedError: (file: File) => string;
  disabled: boolean;
  validate: (file: File) => boolean;
  upload: (file: File, signal?: AbortSignal) => Promise<Document>;
  parse: (
    documentId: string,
    fallbackFilename: string,
    signal?: AbortSignal,
  ) => Promise<Document>;
  formatSummary: (document: Document) => string;
  onReadyChange: (document: Document | null) => void;
};

type CurriculumCourseCreationFormProps = {
  disabled?: boolean;
  externalError?: string;
  onReady: (
    textbook: TextbookDocumentMetadata,
    curriculum: CurriculumDocumentMetadata,
  ) => void;
  onCancel: () => void;
};

export function CurriculumCourseCreationForm({
  disabled = false,
  externalError = "",
  onReady,
  onCancel,
}: CurriculumCourseCreationFormProps) {
  const [textbook, setTextbook] = useState<TextbookDocumentMetadata | null>(null);
  const [curriculum, setCurriculum] = useState<CurriculumDocumentMetadata | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  return (
    <section
      aria-live="polite"
      className="max-h-[min(68vh,680px)] overflow-y-auto rounded-2xl border border-primary/25 bg-gradient-to-b from-primary-light/75 to-surface shadow-md"
    >
      <header className="sticky top-0 z-10 border-b border-primary/15 bg-primary-light/95 px-3.5 py-3 backdrop-blur-sm">
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm">
            <BookOpenCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-primary-text">
              教材 + 培养方案或教学大纲
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              教材提供知识依据，大纲只用于调整知识点清单、重点和知识簇建议。
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-3 p-3.5">
        <SourceUploadCard<TextbookDocumentMetadata>
          title="1. 教材文件"
          description="支持 PDF 或结构化 Markdown，解析章节、知识点与正文证据。"
          chooseLabel="选择教材"
          parsingLabel="正在解析教材结构与正文"
          accept={TEXTBOOK_FILE_ACCEPT}
          emptyError="教材文件为空，请选择有效的 PDF 或 Markdown 文件"
          unsupportedError={() => "请选择 PDF 或 Markdown 格式的教材文件（.pdf、.md）"}
          disabled={disabled}
          validate={isSupportedTextbookFile}
          upload={uploadTextbookDocument}
          parse={parseTextbookDocument}
          formatSummary={formatTextbookSummary}
          onReadyChange={setTextbook}
        />

        <SourceUploadCard<CurriculumDocumentMetadata>
          title="2. 培养方案或教学大纲"
          description="支持 PDF 与 DOCX；旧版 .doc 请先另存为 DOCX 或 PDF。"
          chooseLabel="选择培养方案或大纲"
          parsingLabel="正在提取知识内容要求"
          accept={CURRICULUM_FILE_ACCEPT}
          emptyError="培养方案文件为空，请选择有效的 PDF 或 DOCX 文件"
          unsupportedError={(file) =>
            file.name.trim().toLowerCase().endsWith(".doc")
              ? "暂不支持旧版 .doc，请先另存为 DOCX 或 PDF"
              : "请选择 PDF 或 DOCX 格式的培养方案或教学大纲"
          }
          disabled={disabled}
          validate={isSupportedCurriculumFile}
          upload={uploadCurriculumDocument}
          parse={parseCurriculumDocument}
          formatSummary={formatCurriculumSummary}
          onReadyChange={setCurriculum}
        />

        {externalError && (
          <div className="flex items-start gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs text-error">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{externalError}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-cream hover:text-text-primary"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              if (!textbook || !curriculum || submittingRef.current) return;
              submittingRef.current = true;
              setSubmitting(true);
              onReady(textbook, curriculum);
            }}
            disabled={disabled || submitting || !textbook || !curriculum}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FileCheck2 className="h-3.5 w-3.5" />
            生成知识点清单
          </button>
        </div>
      </div>
    </section>
  );
}

function SourceUploadCard<Document extends CommonDocumentMetadata>({
  title,
  description,
  chooseLabel,
  parsingLabel,
  accept,
  emptyError,
  unsupportedError,
  disabled,
  validate,
  upload,
  parse,
  formatSummary,
  onReadyChange,
}: SourceUploadCardProps<Document>) {
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [phase, setPhase] = useState<ProcessingPhase>("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const uploadedDocumentRef = useRef<Document | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const processFile = useCallback(async (
    nextFile: File,
    existingDocument?: Document,
  ) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setFile(nextFile);
    setDocument(existingDocument ?? null);
    onReadyChange(null);
    if (!existingDocument) uploadedDocumentRef.current = null;
    setError("");
    setPhase(existingDocument ? "parsing" : "uploading");
    try {
      const uploaded = existingDocument ?? await upload(nextFile, controller.signal);
      if (controller.signal.aborted) return;
      uploadedDocumentRef.current = uploaded;
      setDocument(uploaded);
      setPhase("parsing");
      const parsed = await parse(uploaded.id, uploaded.filename, controller.signal);
      if (controller.signal.aborted) return;
      const readyDocument = {
        ...uploaded,
        ...parsed,
        filename: parsed.filename || uploaded.filename,
        sizeBytes: parsed.sizeBytes ?? uploaded.sizeBytes ?? nextFile.size,
      } as Document;
      setDocument(readyDocument);
      setPhase("ready");
      onReadyChange(readyDocument);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setError(reason instanceof Error ? reason.message : "文档处理失败，请重试");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [onReadyChange, parse, upload]);

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    event.target.value = "";
    if (!nextFile) return;
    requestRef.current?.abort();
    requestRef.current = null;
    uploadedDocumentRef.current = null;
    onReadyChange(null);
    setFile(nextFile);
    setDocument(null);
    if (!validate(nextFile)) {
      setPhase("error");
      setError(unsupportedError(nextFile));
      return;
    }
    if (nextFile.size <= 0) {
      setPhase("error");
      setError(emptyError);
      return;
    }
    void processFile(nextFile);
  };

  const reset = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    uploadedDocumentRef.current = null;
    setFile(null);
    setDocument(null);
    setPhase("idle");
    setError("");
    onReadyChange(null);
  };

  const retry = () => {
    if (!file || file.size <= 0 || !validate(file)) return;
    void processFile(
      file,
      uploadedDocumentRef.current ?? document ?? undefined,
    );
  };

  const busy = phase === "uploading" || phase === "parsing";
  const canRetry = Boolean(file && file.size > 0 && validate(file));

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <strong className="block text-xs text-text-primary">{title}</strong>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            {description}
          </p>
        </div>
        {file && !busy && (
          <button
            type="button"
            onClick={reset}
            disabled={disabled}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-cream hover:text-text-primary disabled:opacity-50"
            title="移除文件"
            aria-label="移除文件"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {!file ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="mt-2.5 flex min-h-20 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-primary/30 bg-primary-light/30 px-3 py-3 text-xs font-semibold text-primary-text transition-colors hover:border-primary/55 hover:bg-primary-light/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          {chooseLabel}
        </button>
      ) : (
        <div className="mt-2.5 rounded-lg bg-cream/65 p-2.5">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
              {document?.filename || file.name}
            </span>
            <span className="shrink-0 text-xs text-text-tertiary">
              {formatFileSize(document?.sizeBytes ?? file.size)}
            </span>
          </div>
          {phase !== "error" && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              )}
              <span>
                {phase === "uploading"
                  ? "正在上传"
                  : phase === "parsing"
                    ? parsingLabel
                    : document
                      ? formatSummary(document)
                      : "等待解析"}
              </span>
            </div>
          )}
          {phase === "error" && (
            <div className="mt-2 flex items-start justify-between gap-2 text-xs text-error">
              <span className="inline-flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </span>
              {canRetry && (
                <button
                  type="button"
                  onClick={retry}
                  disabled={disabled}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-error/20 px-2 py-1 font-semibold hover:bg-error/5 disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                  重试
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={chooseFile}
        className="hidden"
      />
    </div>
  );
}

function formatTextbookSummary(document: TextbookDocumentMetadata) {
  const summary = document.outlineSummary;
  if (!summary) return "教材解析完成";
  const metrics = [
    typeof summary.chapterCount === "number" ? `${summary.chapterCount} 章` : "",
    typeof summary.knowledgePointCount === "number"
      ? `${summary.knowledgePointCount} 个候选点`
      : "",
  ].filter(Boolean);
  return metrics.length > 0 ? `教材解析完成 · ${metrics.join(" · ")}` : "教材解析完成";
}

function formatCurriculumSummary(document: CurriculumDocumentMetadata) {
  const summary = document.requirementsSummary;
  if (!summary) return "培养要求解析完成";
  const metrics = [
    typeof summary.unitCount === "number" ? `${summary.unitCount} 个内容单元` : "",
    typeof summary.requirementCount === "number"
      ? `${summary.requirementCount} 条知识要求`
      : "",
  ].filter(Boolean);
  return metrics.length > 0
    ? `培养要求解析完成 · ${metrics.join(" · ")}`
    : "培养要求解析完成";
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
