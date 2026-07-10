/**
 * Shared exact-max ellipsize helper for one-line previews (session titles,
 * first-prompt snippets, subagent task summaries). Distinct from
 * clipTranscriptText in render.ts, which head+tail clips full entry bodies.
 */
export function ellipsizeInline(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}
