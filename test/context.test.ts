import { describe, expect, it } from "vitest";
import { collectContextMessages, selectRecentContext } from "../src/context.js";

const user = (content: unknown) => ({
  type: "message",
  message: { role: "user", content },
});
const assistant = (content: unknown) => ({
  type: "message",
  message: { role: "assistant", content },
});

describe("selectRecentContext", () => {
  it("takes last N qualifying user and assistant text messages in chronological order", () => {
    const entries = [
      user("old"),
      assistant([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "one" },
      ]),
      { type: "compaction", summary: "excluded" },
      user([
        { type: "image", data: "secret" },
        { type: "text", text: "two" },
      ]),
      { type: "custom_message", content: "excluded" },
      assistant([
        { type: "text", text: "three" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "!" },
      ]),
    ];

    expect(selectRecentContext(entries, 3)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "two" }] },
      { role: "assistant", content: [{ type: "text", text: "three!" }] },
    ]);
  });

  it("copies text into an immutable invocation snapshot", () => {
    const block = { type: "text", text: "before invocation" };

    const snapshot = collectContextMessages([assistant([block])]);
    block.text = "mutated later";

    expect(snapshot).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "before invocation" }],
      },
    ]);
  });

  it("drops empty text and excludes non-message roles", () => {
    const entries = [
      user("   "),
      assistant([{ type: "thinking", thinking: "only" }]),
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool" }],
        },
      },
      { type: "message", message: { role: "bashExecution", output: "bash" } },
      user("kept"),
    ];
    expect(selectRecentContext(entries, 99)).toEqual([
      { role: "user", content: [{ type: "text", text: "kept" }] },
    ]);
  });
});
