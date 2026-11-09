import type { CourseMeta, CoursePointDetail } from "./types";

export type QuestionAbilityPresentation = {
  label: string;
  title: string;
  purpose?: string;
};

export type QuestionKnowledgePresentation = {
  title: string;
  relation?: string;
  reason?: string;
};

export type QuestionAnswerPresentation = {
  label: string;
  markdown: string;
};

export type QuestionPresentation = {
  questionType?: string;
  promptMarkdown: string;
  abilities: QuestionAbilityPresentation[];
  knowledge: QuestionKnowledgePresentation[];
  guidance: string[];
  answers: QuestionAnswerPresentation[];
};

/** Question mode is opt-in so legacy practice points keep their existing presentation. */
export function isQuestionPresentationPoint(
  point: Pick<CoursePointDetail, "presentationType"> | null | undefined,
): boolean {
  return point?.presentationType === "question";
}

export function isQuestionBankCourse(
  course: Pick<CourseMeta, "presentationType"> | null | undefined,
): boolean {
  return course?.presentationType === "question-bank";
}

export function questionTypeFromPrompt(value: string | null | undefined): string | undefined {
  const match = value?.match(/(?:^|\n)\s*【题型】\s*([^\n]+)/);
  return match?.[1]?.trim() || undefined;
}

export function normalizeQuestionPrompt(value: string | null | undefined): string {
  if (!value?.trim()) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}#{1,6}[ \t]+(?:题目|题干)[ \t]*\n+/, "")
    .replace(/(?:^|\n)\s*【题型】[^\n]*(?=\n|$)/g, "\n")
    .replace(/【题干】\s*/g, "")
    .replace(/\s*【选项】\s*/g, "\n\n**选项**\n\n")
    .split("\n")
    .map((line) => {
      const option = line.match(/^\s*([A-Za-zＡ-Ｚａ-ｚ])\s*[.．、]\s*(.+)$/);
      const rawLabel = option?.[1];
      const optionText = option?.[2];
      if (!rawLabel || !optionText) return line.trimEnd();
      return `- **${toAsciiLetter(rawLabel).toUpperCase()}.** ${optionText.trim()}`;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeQuestionAbility(value: string): QuestionAbilityPresentation | null {
  const natural = splitBoldLead(value);
  if (natural) {
    const labeledTitle = splitAbilityLabel(natural.title);
    return {
      label: labeledTitle.label,
      title: labeledTitle.title,
      ...(natural.body ? { purpose: natural.body } : {}),
    };
  }

  const parts = splitPresentationFields(value);
  const firstPart = parts[0];
  if (!firstPart) return null;

  const hasCategory = /能力$/.test(firstPart);
  const label = hasCategory ? firstPart : "能力目标";
  const firstContentIndex = hasCategory ? 1 : 0;
  const titleIndex = looksLikeInternalId(parts[firstContentIndex])
    ? firstContentIndex + 1
    : firstContentIndex;
  const title = parts[titleIndex]?.trim();
  if (!title) return null;

  const purpose = findFieldValue(parts.slice(titleIndex + 1), "训练目的");
  return {
    label,
    title,
    ...(purpose ? { purpose } : {}),
  };
}

export function normalizeQuestionKnowledge(value: string): QuestionKnowledgePresentation | null {
  const natural = splitBoldLead(value);
  if (natural) {
    return {
      title: natural.title,
      ...(natural.body ? { reason: natural.body } : {}),
    };
  }

  const parts = splitPresentationFields(value);
  if (parts.length === 0) return null;

  const firstContentIndex = parts[0] === "知识点" ? 1 : 0;
  const titleIndex = looksLikeInternalId(parts[firstContentIndex])
    ? firstContentIndex + 1
    : firstContentIndex;
  const title = parts[titleIndex]?.trim();
  if (!title) return null;

  const metadata = parts.slice(titleIndex + 1);
  const relation = findFieldValue(metadata, "关联");
  const reason = findFieldValue(metadata, "理由");
  return {
    title,
    ...(relation ? { relation } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function buildQuestionPresentation(point: CoursePointDetail): QuestionPresentation {
  return {
    questionType: questionTypeFromPrompt(point.coreIdea),
    promptMarkdown: normalizeQuestionPrompt(point.coreIdea),
    abilities: (point.principles ?? [])
      .map(normalizeQuestionAbility)
      .filter((item): item is QuestionAbilityPresentation => Boolean(item)),
    knowledge: (point.applications ?? [])
      .map(normalizeQuestionKnowledge)
      .filter((item): item is QuestionKnowledgePresentation => Boolean(item)),
    guidance: (point.misconceptions ?? []).map((item) => item.trim()).filter(Boolean),
    answers: (point.qa ?? [])
      .map((item) => ({ label: item.q.trim(), markdown: item.a.trim() }))
      .filter((item) => item.label && item.markdown),
  };
}

function splitPresentationFields(value: string): string[] {
  return value.split(/\s*[｜|]\s*/).map((part) => part.trim()).filter(Boolean);
}

function splitBoldLead(value: string): { title: string; body?: string } | null {
  const match = value.trim().match(/^\*\*(.+?)\*\*\s*[：:]\s*([\s\S]+)$/);
  if (!match?.[1]?.trim()) return null;
  return {
    title: match[1].trim(),
    ...(match[2]?.trim() ? { body: match[2].trim() } : {}),
  };
}

function splitAbilityLabel(value: string): { label: string; title: string } {
  const match = value.match(/^(.*?)[（(](重点能力|主能力|协同能力)[）)]\s*$/);
  const title = match?.[1]?.trim();
  const rawLabel = match?.[2];
  if (!title || !rawLabel) return { label: "能力目标", title: value };
  return {
    label: rawLabel === "主能力" ? "重点能力" : rawLabel,
    title,
  };
}

function looksLikeInternalId(value: string | undefined): boolean {
  return Boolean(value && /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value));
}

function findFieldValue(parts: string[], field: string): string | undefined {
  const matcher = new RegExp(`^${field}\\s*[：:]\\s*(.+)$`);
  for (const part of parts) {
    const match = part.match(matcher);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function toAsciiLetter(value: string): string {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return value;
  if (codePoint >= 0xff21 && codePoint <= 0xff3a) return String.fromCodePoint(codePoint - 0xfee0);
  if (codePoint >= 0xff41 && codePoint <= 0xff5a) return String.fromCodePoint(codePoint - 0xfee0);
  return value;
}
