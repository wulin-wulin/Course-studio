export type DocumentOutlineSummary = {
  title?: string;
  chapterCount?: number;
  knowledgePointCount?: number;
};

export type TextbookDocumentMetadata = {
  id: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
  status?: string;
  outlineSummary?: DocumentOutlineSummary;
};

export type TextbookOutlinePoint = {
  id: string;
  title: string;
  order?: number;
};

export type TextbookOutlineChapter = {
  id: string;
  title: string;
  order?: number;
  points: TextbookOutlinePoint[];
};

export type TextbookOutline = {
  title?: string;
  chapters: TextbookOutlineChapter[];
};

export class DocumentApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "DocumentApiError";
    this.status = status;
  }
}

export async function uploadTextbookDocument(
  file: File,
  signal?: AbortSignal,
): Promise<TextbookDocumentMetadata> {
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await fetch("/api/documents", {
    method: "POST",
    body,
    signal,
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw makeApiError(response.status, payload, "教材上传失败");
  }
  return parseDocumentMetadata(payload, { fallbackFilename: file.name });
}

export async function parseTextbookDocument(
  documentId: string,
  fallbackFilename = "",
  signal?: AbortSignal,
): Promise<TextbookDocumentMetadata> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/parse`,
    { method: "POST", signal },
  );
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw makeApiError(response.status, payload, "教材解析失败");
  }
  return parseDocumentMetadata(payload, {
    fallbackId: documentId,
    fallbackFilename,
  });
}

export async function fetchTextbookOutline(
  documentId: string,
  signal?: AbortSignal,
): Promise<TextbookOutline> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/outline`,
    { cache: "no-store", signal },
  );
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw makeApiError(response.status, payload, "教材纲要加载失败");
  }
  return parseTextbookOutline(payload);
}

function parseDocumentMetadata(
  payload: unknown,
  fallback: { fallbackId?: string; fallbackFilename?: string } = {},
): TextbookDocumentMetadata {
  if (!isRecord(payload)) {
    throw new DocumentApiError("文档服务返回了无效响应");
  }
  const candidate = isRecord(payload.document) ? payload.document : payload;
  const id =
    readString(candidate, "id", "document_id") ||
    fallback.fallbackId?.trim() ||
    "";
  const filename =
    readString(candidate, "filename", "original_filename", "name") ||
    fallback.fallbackFilename?.trim() ||
    "";
  if (!id || !filename) {
    throw new DocumentApiError("文档响应缺少 id 或 filename");
  }
  const outlineValue =
    candidate.outline_summary ??
    candidate.outlineSummary ??
    payload.outline_summary ??
    payload.outlineSummary;
  const outlineSummary = parseOutlineSummary(outlineValue);
  return {
    id,
    filename,
    ...optionalString(
      "contentType",
      candidate.content_type ?? candidate.contentType,
    ),
    ...optionalNumber("sizeBytes", candidate.size_bytes ?? candidate.sizeBytes),
    ...optionalString("sha256", candidate.sha256),
    ...optionalString("status", candidate.status),
    ...(outlineSummary ? { outlineSummary } : {}),
  };
}

function parseOutlineSummary(value: unknown): DocumentOutlineSummary | null {
  if (!isRecord(value)) return null;
  const summary: DocumentOutlineSummary = {
    ...optionalString("title", value.title),
    ...optionalNumber(
      "chapterCount",
      value.chapter_count ?? value.chapterCount ?? value.chapters,
    ),
    ...optionalNumber(
      "knowledgePointCount",
      value.knowledge_point_count ??
        value.knowledgePointCount ??
        value.point_count ??
        value.pointCount ??
        value.points,
    ),
  };
  return Object.keys(summary).length > 0 ? summary : null;
}

function parseTextbookOutline(payload: unknown): TextbookOutline {
  const candidate =
    isRecord(payload) && isRecord(payload.outline) ? payload.outline : payload;
  if (!isRecord(candidate) || !Array.isArray(candidate.chapters)) {
    throw new DocumentApiError("教材纲要响应缺少 chapters");
  }
  const chapters = candidate.chapters.map((chapter, chapterIndex) => {
    if (!isRecord(chapter)) {
      throw new DocumentApiError(`第 ${chapterIndex + 1} 个章节格式无效`);
    }
    const id = readString(chapter, "id");
    const title = readString(chapter, "title");
    if (!id || !title || !Array.isArray(chapter.points)) {
      throw new DocumentApiError(`第 ${chapterIndex + 1} 个章节信息不完整`);
    }
    const points = chapter.points.map((point, pointIndex) => {
      if (!isRecord(point)) {
        throw new DocumentApiError(
          `章节“${title}”的第 ${pointIndex + 1} 个知识点格式无效`,
        );
      }
      const pointId = readString(point, "id");
      const pointTitle = readString(point, "title");
      if (!pointId || !pointTitle) {
        throw new DocumentApiError(
          `章节“${title}”的第 ${pointIndex + 1} 个知识点信息不完整`,
        );
      }
      return {
        id: pointId,
        title: pointTitle,
        ...optionalNumber("order", point.order),
      };
    });
    return {
      id,
      title,
      ...optionalNumber("order", chapter.order),
      points,
    };
  });
  return {
    ...optionalString("title", candidate.title),
    chapters,
  };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function makeApiError(status: number, payload: unknown, fallback: string) {
  const detail = extractErrorDetail(payload);
  return new DocumentApiError(detail || `${fallback}（${status}）`, status);
}

function extractErrorDetail(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (!isRecord(payload)) return "";
  const detail = payload.detail ?? payload.message ?? payload.error;
  if (typeof detail === "string") return detail.trim();
  if (isRecord(detail)) {
    return readString(detail, "message", "detail");
  }
  if (Array.isArray(detail)) {
    return detail
      .flatMap((item) => {
        if (!isRecord(item)) return [];
        const message = readString(item, "msg", "message", "detail");
        return message ? [message] : [];
      })
      .join("；");
  }
  return "";
}

function readString(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  return typeof value === "string" && value.trim()
    ? ({ [key]: value.trim() } as Record<Key, string>)
    : {};
}

function optionalNumber<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? ({ [key]: value } as Record<Key, number>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
