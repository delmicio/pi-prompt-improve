export interface ContextMessage {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
}

interface EntryLike {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}

export function collectContextMessages(
  entries: readonly unknown[],
): ContextMessage[] {
  const messages: ContextMessage[] = [];
  for (const candidate of entries) {
    const entry = candidate as EntryLike;
    if (entry.type !== "message") continue;
    const message = entry.message;
    const role = message?.role;
    if (!message || (role !== "user" && role !== "assistant")) continue;
    const text = extractText(message.content);
    if (text.trim().length === 0) continue;
    messages.push({ role, content: [{ type: "text", text }] });
  }
  return messages;
}

export function selectRecentContext(
  entries: readonly unknown[],
  count: number,
): ContextMessage[] {
  return collectContextMessages(entries).slice(-count);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}
