import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PreviewComponent } from "../src/ui.js";

const theme = {
  fg: (color: string, text: string) =>
    color === "borderAccent" ? `\u001b[36m${text}\u001b[0m` : text,
  bold: (text: string) => text,
} as never;

/** Strip SGR color sequences for exact-match assertions. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("PreviewComponent", () => {
  it("renders the status in the frame border and defaults Enter to Replace", () => {
    const done = vi.fn();
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "high",
        original: "a",
        improved: "same\nbody",
      },
      theme,
      done,
      5,
    );
    const lines = component.render(80);
    expect(
      plain(lines[0] ?? "").startsWith(
        "╭─ Improved prompt · p/m · Thinking: high · 9 chars (+8) ",
      ),
    ).toBe(true);
    expect(plain(lines[0] ?? "").endsWith("╮")).toBe(true);
    expect(plain(lines.at(-1) ?? "")).toMatch(
      /^╰─ ↵ Replace · R ⌘I \^I Retry · Esc Keep .+╯$/,
    );
    const body = plain(lines.slice(1, -1).join("\n"));
    expect(body).toContain("│ same");
    expect(body).toContain("│ body");
    expect(body).not.toContain("\na\n");
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith("replace");
  });

  it("renders every framed row at the exact requested width", () => {
    const component = new PreviewComponent(
      {
        identity: "openai-codex/gpt-5.6-sol",
        thinking: "off",
        original: "a",
        improved: "improved body text",
      },
      theme,
      vi.fn(),
    );
    for (const width of [80, 40, 20, 10]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  it("drops status tiers before the primary when the border is narrow", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "improved",
      },
      theme,
      vi.fn(),
    );
    const header = plain(component.render(30)[0] ?? "");
    expect(header).toContain("Improved prompt");
    expect(header).not.toContain("chars (");
    expect(header).not.toContain("Thinking:");
  });

  it("wraps the re-homed header row instead of truncating the delta", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "default",
        original: "a",
        improved: "same\nbody",
      },
      theme,
      vi.fn(),
      5,
    );
    const lines = component.render(30).map(plain);
    expect(lines[0]).not.toContain("chars");
    const inner = lines.slice(1).join("\n");
    expect(inner).toContain("9 chars (+8)");
    expect(inner).toContain("│ same");
  });

  it("re-homes the actions to body rows when the border cannot fit them", () => {
    const component = new PreviewComponent(
      { identity: "p/m", thinking: "medium", original: "o", improved: "i" },
      theme,
      vi.fn(),
    );
    // Width 20 leaves a 14-column bottom-border budget, below even the
    // 17-wide glyph form, so the actions move into wrapped body rows.
    const rows = component.render(20).map(plain);
    expect(rows.at(-1)).toMatch(/^╰─+╯$/);
    const body = rows.slice(1, -1).join("\n");
    expect(body).toContain("↵ Replace");
    expect(body).toContain("R ⌘I ^I Retry");
    expect(body).toContain("Esc Keep");
    // Width 18 must still show every key, wrapped rather than truncated.
    const narrow = plain(component.render(18).join(""));
    expect(narrow.replace(/\s+/g, "")).toContain("R⌘I^I");
  });

  it("sanitizes escape sequences and tabs from model output before framing", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "o",
        improved: "hello \u001b[41m\u001b[5mRED\u001b[2J tail\ttabbed",
      },
      theme,
      vi.fn(),
    );
    const rendered = component.render(60).map(plain).join("\n");
    expect(rendered).toContain("hello RED tail");
    expect(rendered).toContain("tabbed");
    expect(rendered).not.toContain("\u001b[");
    for (const line of component.render(60)) {
      expect(visibleWidth(line)).toBe(60);
    }
  });

  it("keeps dropped header tiers visible on the first line inside the frame", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "high",
        original: "a",
        improved: "same\nbody",
      },
      theme,
      vi.fn(),
      5,
    );
    // Width 58: full status is 54 wide, budget 52, so the count drops from
    // the border but must reappear inside the frame.
    const lines = component.render(58).map(plain);
    expect(lines[0]).not.toContain("chars (+8)");
    const inner = lines.slice(1).join("\n");
    expect(inner).toContain("9 chars (+8)");
    expect(inner).toContain("│ same");
  });

  it("wraps the non-idle warning and footnote instead of truncating them", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "o",
        improved: "i",
        mainRunContinues: true,
      },
      theme,
      vi.fn(),
    );
    const narrow = plain(component.render(40).join("\n"));
    expect(narrow).toContain("has not been");
    expect(narrow).toContain("submitted");
    const mid = plain(component.render(56).join("\n"));
    expect(mid).toContain("has not been");
    expect(mid).toContain("submitted");
    const tiny = plain(component.render(24).join("\n"));
    expect(tiny).toContain("Original remains");
    expect(tiny).toContain("visible below");
    for (const width of [56, 40, 24]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  it("returns Retry when R is pressed", () => {
    const done = vi.fn();
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "first attempt",
      },
      theme,
      done,
    );

    component.handleInput("r");

    expect(done).toHaveBeenCalledWith("retry");
  });

  it.each([
    ["Cmd+I", "\x1b[105;9u"],
    ["Ctrl+Shift+I", "\x1b[105;6u"],
  ])(
    "returns Retry when invocation shortcut %s is pressed",
    (_label, input) => {
      const done = vi.fn();
      const component = new PreviewComponent(
        {
          identity: "p/m",
          thinking: "medium",
          original: "original",
          improved: "first attempt",
        },
        theme,
        done,
      );

      component.handleInput(input);

      expect(done).toHaveBeenCalledWith("retry");
    },
  );

  it("ignores key release and repeat packets for Retry", () => {
    const done = vi.fn();
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "improved",
      },
      theme,
      done,
    );

    component.handleInput("\x1b[105;9:3u");
    component.handleInput("\x1b[105;9:2u");
    component.handleInput("\x1b[114;1:3u");
    component.handleInput("\x1b[114;1:2u");

    expect(done).not.toHaveBeenCalled();
  });

  it("allows repeat packets for preview scrolling", () => {
    const improved = Array.from(
      { length: 20 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved,
      },
      theme,
      vi.fn(),
      4,
    );
    component.render(80);

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[1;1:2B");

    const lines = component.render(80).map(plain);
    expect(lines[0]).toContain("↑ 2");
    expect(lines.at(-1)).toContain("↓ 14");
    expect(lines.join("\n")).not.toContain("Lines ");
  });

  it("embeds scroll arrows only on the clipped sides of the viewport", () => {
    const improved = Array.from(
      { length: 22 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved,
      },
      theme,
      vi.fn(),
      18,
    );
    // Top of the document: only the bottom arrow shows (4 hidden below).
    const top = component.render(80).map(plain);
    expect(top[0]).not.toContain("↑");
    expect(top.at(-1)).toContain("↓ 4");
    // Scrolled into the middle: both arrows count their hidden sides.
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    const middle = component.render(80).map(plain);
    expect(middle[0]).toContain("↑ 2");
    expect(middle.at(-1)).toContain("↓ 2");
    // Bottom of the document: only the top arrow remains.
    component.handleInput("\x1b[6~");
    component.handleInput("\x1b[6~");
    const bottom = component.render(80).map(plain);
    expect(bottom[0]).toContain("↑ 4");
    expect(bottom.at(-1)).not.toContain("↓");
  });

  it("shows no arrows when the whole body is visible", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "a",
        improved: "same\nbody",
      },
      theme,
      vi.fn(),
      5,
    );
    const borders = component
      .render(80)
      .map(plain)
      .filter((_, index, rows) => index === 0 || index === rows.length - 1);
    expect(borders.join("")).not.toMatch(/[↑↓]/);
  });

  it("renders the actions in the bottom border at wide widths", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "improved",
      },
      theme,
      vi.fn(),
    );
    const rows = component.render(100).map(plain);
    const bottom = rows.at(-1) ?? "";
    expect(bottom.startsWith("╰─ ↵ Replace · R ⌘I ^I Retry · Esc Keep ")).toBe(
      true,
    );
    expect(bottom.endsWith("╯")).toBe(true);
    expect(rows.join("\n")).not.toContain("PgUp");
  });

  it("degrades the action label right-first before leaving the border", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "improved",
      },
      theme,
      vi.fn(),
    );
    // Budget 34 fits neither the 36-wide full form nor its "Retry" word.
    const medium = plain(component.render(40).at(-1) ?? "");
    expect(medium).toContain("↵ Replace · R ⌘I ^I · Esc");
    expect(medium).not.toContain("Retry");
    expect(medium).not.toContain("Keep");
    // Budget 24 keeps only the key glyphs.
    const narrow = plain(component.render(30).at(-1) ?? "");
    expect(narrow).toContain("↵ · R ⌘I ^I · Esc");
  });

  it("keeps every retry key visible at every usable width", () => {
    const improved = Array.from(
      { length: 22 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const component = new PreviewComponent(
      { identity: "p/m", thinking: "medium", original: "o", improved },
      theme,
      vi.fn(),
      18,
    );
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    for (const width of [
      120, 100, 80, 66, 60, 50, 44, 40, 36, 32, 30, 28, 26, 24, 23, 22, 20, 18,
      16, 14, 12, 10, 9, 8, 7, 6, 5,
    ]) {
      const rows = component.render(width);
      for (const row of rows) {
        expect(visibleWidth(row), `width ${width}`).toBe(width);
      }
      const flat = plain(rows.join("")).replace(/[\s│─╭╮╰╯]/g, "");
      expect(flat, `width ${width}`).toContain("R⌘I^I");
    }
  });

  it("keeps retry, replace, and keep hints visible at narrow widths", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "medium",
        original: "original",
        improved: "improved",
      },
      theme,
      vi.fn(),
    );

    const rendered = plain(component.render(40).join("\n"));

    expect(rendered).toContain("↵ Replace");
    expect(rendered).toContain("R ⌘I ^I");
    expect(rendered).toContain("Esc");
    expect(rendered).toContain("Original remains visible below");
  });

  it("keeps on Escape and scrolls without mutating source", () => {
    const done = vi.fn();
    const improved = Array.from(
      { length: 20 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const component = new PreviewComponent(
      { identity: "p/m", thinking: "default", original: "old", improved },
      theme,
      done,
      4,
    );
    const before = component.render(20).join("\n");
    component.handleInput("\x1b[B");
    const after = component.render(20).join("\n");
    expect(after).not.toBe(before);
    expect(component.source).toBe(improved);
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith("keep");
  });

  it("shows equality preview with ±0", () => {
    const component = new PreviewComponent(
      {
        identity: "p/m",
        thinking: "default",
        original: "👨‍👩‍👧‍👦",
        improved: "👨‍👩‍👧‍👦",
      },
      theme,
      vi.fn(),
    );
    expect(component.render(100)[0]).toContain(
      "Thinking: Model default · 1 chars (±0)",
    );
  });
});
