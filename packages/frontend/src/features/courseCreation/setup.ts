export const COURSE_CREATION_SETUP_QUESTION = {
  header: "课程主题",
  question: "你想创建什么课程？请填写明确的课程名称或学习领域。",
  options: [],
  multiple: false,
  custom: true,
};

export function normalizeCourseCreationTopic(answers: string[][]): string {
  return answers
    .flat()
    .map((answer) => answer.trim())
    .filter(Boolean)
    .join("、");
}

export function buildCourseCreationMessage(topic: string): string {
  return [
    "开始创建课程。",
    `课程或领域名称：${topic}。`,
    "请以这个主题启动课程创建流程；如果还需要目标受众、难度等信息，再通过问题卡片向我确认。",
  ].join("");
}

export function buildCourseCreationDisplayContent(topic: string): string {
  return `创建课程：${topic}`;
}

export type PreparedCourseCreationRequest = {
  topic: string;
  message: string;
  displayContent: string;
};

export type PreparedPdfCourseCreationRequest = {
  documentId: string;
  filename: string;
  message: string;
  displayContent: string;
};

export const TEXTBOOK_FILE_ACCEPT = [
  "application/pdf",
  ".pdf",
  "text/markdown",
  "application/markdown",
  "text/x-markdown",
  "text/plain",
  ".md",
  ".markdown",
].join(",");

export const MARKDOWN_TEXTBOOK_FILE_ACCEPT = [
  "text/markdown",
  "application/markdown",
  "text/x-markdown",
  "text/plain",
  ".md",
  ".markdown",
].join(",");

type TextbookFileDescriptor = {
  name: string;
  type?: string;
};

const NEUTRAL_FILE_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);
const PDF_FILE_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const MARKDOWN_FILE_TYPES = new Set([
  "text/markdown",
  "application/markdown",
  "text/x-markdown",
  "text/plain",
]);

export function isSupportedTextbookFile(file: TextbookFileDescriptor): boolean {
  const filename = file.name.trim().toLowerCase();
  const mediaType = ((file.type ?? "").split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  if (filename.endsWith(".pdf")) {
    return PDF_FILE_TYPES.has(mediaType) || NEUTRAL_FILE_TYPES.has(mediaType);
  }
  return isSupportedMarkdownTextbookFile(file);
}

export function isSupportedMarkdownTextbookFile(
  file: TextbookFileDescriptor,
): boolean {
  const filename = file.name.trim().toLowerCase();
  const mediaType = ((file.type ?? "").split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  return (
    (filename.endsWith(".md") || filename.endsWith(".markdown")) &&
    (MARKDOWN_FILE_TYPES.has(mediaType) || NEUTRAL_FILE_TYPES.has(mediaType))
  );
}

export function prepareCourseCreationRequest(
  answers: string[][],
): PreparedCourseCreationRequest | null {
  const topic = normalizeCourseCreationTopic(answers);
  if (!topic) return null;
  return {
    topic,
    message: buildCourseCreationMessage(topic),
    displayContent: buildCourseCreationDisplayContent(topic),
  };
}

export function buildPdfCourseCreationMessage(filename: string): string {
  return [
    "开始根据已上传并解析完成的教材文件创建课程。",
    `教材文件：${filename}。`,
    "读取后端绑定的教材结构、material.json 和 full.md，完整识别并保留教材中的“章节 → 知识点”结构与原有阅读顺序。",
    "生成每个知识点的正文时，必须阅读 full.md 中对应的教材内容，并以 material.json 中可定位的正文证据为基础；不得只根据标题编写内容。",
    "可以使用 LLM 丰富教材知识点并补充缺失知识点，但必须保留 origin、sourceSpans、modelEnriched 等溯源信息，模型补充内容不得伪装成教材原文。",
    "结构确认后，扩展知识点必须归入合适的教材章节，后续不得重新聚类或改变已确认的章节归属。",
    "如果还需要目标受众、难度等信息，再通过问题卡片向我确认。",
  ].join("");
}

export function preparePdfCourseCreationRequest(document: {
  id: string;
  filename: string;
}): PreparedPdfCourseCreationRequest | null {
  const documentId = document.id.trim();
  const filename = document.filename.trim();
  if (!documentId || !filename) return null;
  return {
    documentId,
    filename,
    message: buildPdfCourseCreationMessage(filename),
    displayContent: `根据教材创建课程：${filename}`,
  };
}

export function prepareMarkdownCourseCreationRequest(document: {
  id: string;
  filename: string;
}): PreparedPdfCourseCreationRequest | null {
  const request = preparePdfCourseCreationRequest(document);
  if (!request) return null;
  return {
    ...request,
    displayContent: `根据 Markdown 生成知识图谱：${request.filename}`,
  };
}
