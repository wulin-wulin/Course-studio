import { isRecord } from './common.mjs';

// worker 只写 span 的短引用；受信脚本按同一规则把引用展开回 manifest 中的完整 span。
// 当前教材生成器总是输出 blockIds: [section.id]，因此 ref 通常就是该 section ID。
export function sourceSpanRef(span) {
  if (
    !isRecord(span)
    || !Array.isArray(span.blockIds)
    || span.blockIds.length < 1
    || !span.blockIds.every((id) => typeof id === 'string' && id !== '')
  ) {
    return null;
  }
  return span.blockIds.length === 1
    ? span.blockIds[0]
    : span.blockIds.join('+');
}

// 返回 ref → 可信 span；同一点内 ref 不唯一或无法派生时记录错误，调用方据此失败。
export function buildSourceSpanRefMap(spans, label, errors) {
  const refs = new Map();
  if (!Array.isArray(spans)) {
    errors.push(`${label} 必须是数组`);
    return refs;
  }
  spans.forEach((span, index) => {
    const ref = sourceSpanRef(span);
    if (ref === null) {
      errors.push(`${label}[${index}] 缺少可派生 ref 的 blockIds`);
      return;
    }
    if (refs.has(ref)) {
      errors.push(`${label} 的 ref 不唯一: ${ref}`);
      return;
    }
    refs.set(ref, span);
  });
  return refs;
}

// 逐个访问 textbook-content/2.0 内容块里的 provenance.sourceSpans 数组。
export function forEachBlockSourceSpans(point, visit) {
  if (!isRecord(point?.content) || !Array.isArray(point.content.blocks)) return;
  point.content.blocks.forEach((block, blockIndex) => {
    if (
      isRecord(block?.provenance)
      && Array.isArray(block.provenance.sourceSpans)
    ) {
      visit(block.provenance.sourceSpans, blockIndex, block);
    }
  });
}

export function collectUnexpandedSourceSpanRefs(point) {
  const unexpanded = [];
  forEachBlockSourceSpans(point, (spans, blockIndex) => {
    spans.forEach((span, spanIndex) => {
      if (typeof span === 'string') {
        unexpanded.push({ blockIndex, spanIndex, ref: span });
      }
    });
  });
  return unexpanded;
}
