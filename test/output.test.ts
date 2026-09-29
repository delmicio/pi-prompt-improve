import { describe, expect, it } from "vitest";
import {
  countGraphemes,
  formatDelta,
  normalizeModelOutput,
  previewStatus,
} from "../src/output.js";

describe("model output", () => {
  it("concatenates text blocks, ignores thinking, preserves fences, and normalizes line endings", () => {
    expect(
      normalizeModelOutput([
        { type: "text", text: "```ts\r\n" },
        { type: "thinking", thinking: "ignore" },
        { type: "text", text: "code\r```" },
      ]),
    ).toBe("```ts\ncode\n```");
  });

  it("rejects blank output", () => {
    expect(() =>
      normalizeModelOutput([{ type: "text", text: "  \n" }]),
    ).toThrow("empty");
  });

  it("counts Unicode grapheme clusters and formats signed deltas", () => {
    expect(countGraphemes("e\u0301👨‍👩‍👧‍👦🇺🇸")).toBe(3);
    expect(formatDelta(4)).toBe("+4");
    expect(formatDelta(-4)).toBe("−4");
    expect(formatDelta(0)).toBe("±0");
  });

  it("splits the preview status into primary, secondary, and count tiers", () => {
    expect(previewStatus("p/m", "high", "a", "same\nbody")).toEqual({
      primary: "Improved prompt",
      model: "p/m",
      thinking: "Thinking: high",
      count: "9 chars (+8)",
    });
  });

  it("labels unset thinking as Model default in the status tiers", () => {
    expect(previewStatus("p/m", "default", "x", "x").thinking).toBe(
      "Thinking: Model default",
    );
    expect(previewStatus("p/m", "default", "a", "a").count).toBe(
      "1 chars (±0)",
    );
    expect(previewStatus("p/m", "default", "longest", "short").count).toBe(
      "5 chars (−2)",
    );
  });
});
