import { describe, expect, it } from "vitest";
import { IMPROVE_SHORTCUTS, matchesImproveShortcut } from "../src/shortcuts.js";

describe("Prompt Improver shortcuts", () => {
  it("defines the two fixed invocation shortcuts", () => {
    expect(IMPROVE_SHORTCUTS).toEqual(["super+i", "ctrl+shift+i"]);
  });

  it.each([
    ["Cmd+I", "\x1b[105;9u"],
    ["Ctrl+Shift+I", "\x1b[105;6u"],
  ])("recognizes %s Kitty terminal input", (_label, input) => {
    expect(matchesImproveShortcut(input)).toBe(true);
  });

  it("does not consume unrelated keys as improvement shortcuts", () => {
    expect(matchesImproveShortcut("r")).toBe(false);
    expect(matchesImproveShortcut("\r")).toBe(false);
  });
});
