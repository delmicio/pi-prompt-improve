interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
}

export function normalizeModelOutput(content: readonly unknown[]): string {
  const text = content
    .map((candidate) => candidate as ContentBlockLike)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) throw new Error("Model returned empty output");
  return text;
}

export function countGraphemes(text: string): number {
  return Array.from(
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
  ).length;
}

export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return "±0";
}

export interface PreviewStatus {
  primary: string;
  model: string;
  thinking: string;
  count: string;
}

export function previewStatus(
  identity: string,
  thinking: string,
  original: string,
  improved: string,
): PreviewStatus {
  const count = countGraphemes(improved);
  const delta = count - countGraphemes(original);
  const thinkingLabel = thinking === "default" ? "Model default" : thinking;
  return {
    primary: "Improved prompt",
    model: identity,
    thinking: `Thinking: ${thinkingLabel}`,
    count: `${count.toLocaleString("en-US")} chars (${formatDelta(delta)})`,
  };
}
