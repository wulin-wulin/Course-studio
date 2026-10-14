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
    "开始根据已上传并解析完成的 PDF 教材创建课程。",
    `教材文件：${filename}。`,
    "先提取并保留教材中的“章节 → 知识点”两层结构，确保教材覆盖的知识点范围完整体现。",
    "当前阶段关注章节、知识点名称及其归属，不要求逐段还原教材正文。",
    "结构确认后，再使用 LLM 扩充知识点和教学内容；扩展知识点必须归入合适的原教材章节，后续不得重新聚类或改变已确认的章节归属。",
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
