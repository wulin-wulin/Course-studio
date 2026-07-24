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
