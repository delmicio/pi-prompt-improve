import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  arrowFits,
  arrowPad,
  droppedStatusParts,
  fitStatusLabel,
  frameBottomBorder,
  frameBorderColor,
  frameContentWidth,
  frameRow,
  frameTopBorder,
  sanitizeFrameText,
} from "../src/frame.js";

/** Strip SGR color sequences for exact-match assertions. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const identity = (s: string) => s;

const full = {
  primary: "Improved prompt",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "Thinking: off",
  count: "259 chars (+171)",
};

describe("fitStatusLabel", () => {
  it("keeps every tier when the full label fits", () => {
    expect(fitStatusLabel(full, 77)).toEqual(full);
  });

  it("drops the count first", () => {
    const fitted = fitStatusLabel(full, 76);
    expect(fitted.count).toBeUndefined();
    expect(fitted.thinking).toBe("Thinking: off");
    expect(fitted.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("drops thinking before ellipsizing the model", () => {
    const fitted = fitStatusLabel(full, 57);
    expect(fitted.count).toBeUndefined();
    expect(fitted.thinking).toBeUndefined();
    expect(fitted.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("ellipsizes the model while keeping the primary intact", () => {
    const fitted = fitStatusLabel(full, 30);
    expect(fitted.primary).toBe("Improved prompt");
    expect(fitted.model).toBe("openai-code…");
    expect(fitted.thinking).toBeUndefined();
    expect(fitted.count).toBeUndefined();
  });

  it("truncates the primary only as a last resort", () => {
    const fitted = fitStatusLabel(full, 10);
    expect(fitted.primary).toBe("Improved …");
    expect(fitted.model).toBeUndefined();
    expect(fitted.thinking).toBeUndefined();
    expect(fitted.count).toBeUndefined();
  });

  it("handles a status with only a primary", () => {
    expect(fitStatusLabel({ primary: "Preparing" }, 30)).toEqual({
      primary: "Preparing",
    });
    expect(fitStatusLabel({ primary: "Preparing" }, 4)).toEqual({
      primary: "Pre…",
    });
  });
});

describe("frame borders", () => {
  it("embeds the label in the top border at the exact width", () => {
    const top = frameTopBorder("Hi", 40, identity);
    expect(top).toBe(`╭─ Hi ${"─".repeat(33)}╮`);
    expect(visibleWidth(top)).toBe(40);
  });

  it("keeps the border color on both sides of a styled label", () => {
    const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;
    const redLabel = `\u001b[31mHi\u001b[0m`;
    const top = frameTopBorder(redLabel, 40, cyan);
    // Prefix segment is cyan, label keeps its own color, and the trailing
    // dashes + corner must be cyan again after the label's reset sequence.
    expect(top.startsWith(`\u001b[36m╭─ \u001b[0m`)).toBe(true);
    expect(top).toContain(`\u001b[31mHi\u001b[0m`);
    expect(top.endsWith(`\u001b[36m ${"─".repeat(33)}╮\u001b[0m`)).toBe(true);
    expect(visibleWidth(top)).toBe(40);
  });

  it("truncates an over-long label to its border budget", () => {
    const top = frameTopBorder("Improved prompt · p/m", 20, identity);
    expect(top.startsWith("╭─ Improved prom… ")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
    expect(visibleWidth(top)).toBe(20);
  });

  it("renders a plain top border at degenerate widths", () => {
    expect(frameTopBorder("Improved prompt", 6, identity)).toBe(
      `╭${"─".repeat(4)}╮`,
    );
  });

  it("pads and truncates content rows inside side columns", () => {
    expect(frameRow("hello", 20, identity)).toBe(`│ hello${" ".repeat(11)} │`);
    expect(frameRow("abcdefghij", 12, identity)).toBe(`│ abcdefg… │`);
    expect(visibleWidth(frameRow("x", 20, identity))).toBe(20);
  });

  it("measures ANSI content by visible width only", () => {
    const row = frameRow("\x1b[31mred\x1b[0m", 20, identity);
    expect(visibleWidth(row)).toBe(20);
    expect(row.startsWith("│ \x1b[31mred\x1b[0m")).toBe(true);
  });

  it("renders the bottom border", () => {
    expect(frameBottomBorder("", 20, identity)).toBe(`╰${"─".repeat(18)}╯`);
  });

  it("embeds a label in the bottom border like the top", () => {
    const bottom = frameBottomBorder("Hi", 20, identity);
    expect(bottom).toBe(`╰─ Hi ${"─".repeat(13)}╯`);
    expect(visibleWidth(bottom)).toBe(20);
  });

  it("measures wide characters by display width, never code points", () => {
    const cjk = "你好世界你好世界你好世界";
    const row = frameRow(cjk, 20, identity);
    expect(visibleWidth(row)).toBe(20);
    expect(row).toContain("…");
    const top = frameTopBorder("改善提案の確認", 20, identity);
    expect(visibleWidth(top)).toBe(20);
  });

  it("derives the shared content width used by rows and wrapping", () => {
    expect(frameContentWidth(20)).toBe(16);
    expect(frameContentWidth(6)).toBe(2);
    expect(frameContentWidth(4)).toBe(0);
    expect(frameContentWidth(1)).toBe(0);
  });

  it("never overflows below the minimum frame width", () => {
    for (const width of [1, 2, 3, 4, 5]) {
      expect(
        visibleWidth(frameRow("abcdef", width, identity)),
      ).toBeLessThanOrEqual(width);
    }
  });
});

describe("border arrows", () => {
  it("embeds a right-edge arrow in the top border at the exact width", () => {
    const top = frameTopBorder("Hi", 20, identity, "↑ 2");
    expect(top).toBe(`╭─ Hi ${"─".repeat(7)} ↑ 2 ─╮`);
    expect(visibleWidth(top)).toBe(20);
  });

  it("embeds a label and arrow in the bottom border at the exact width", () => {
    const bottom = frameBottomBorder("Hi", 20, identity, "↓ 4");
    expect(bottom).toBe(`╰─ Hi ${"─".repeat(7)} ↓ 4 ─╯`);
    expect(visibleWidth(bottom)).toBe(20);
  });

  it("renders an arrow-only border when there is no label", () => {
    const bottom = frameBottomBorder("", 20, identity, "↓ 4");
    expect(bottom).toBe(`╰${"─".repeat(12)} ↓ 4 ─╯`);
    expect(visibleWidth(bottom)).toBe(20);
  });

  it("shrinks the label budget so the arrow wins the right edge", () => {
    // Budget without the arrow is 14; the 3-wide arrow drops it to 8, so
    // a 21-wide label ellipsizes harder than it would without the arrow.
    const withArrow = frameTopBorder(
      "Improved prompt · p/m",
      20,
      identity,
      "↑ 2",
    );
    expect(withArrow.startsWith("╭─ Improve… ")).toBe(true);
    expect(withArrow.endsWith(" ↑ 2 ─╮")).toBe(true);
    expect(visibleWidth(withArrow)).toBe(20);
    const withoutArrow = frameTopBorder("Improved prompt · p/m", 20, identity);
    expect(withoutArrow.startsWith("╭─ Improved prom… ")).toBe(true);
  });

  it("keeps the border color on every segment around a styled arrow", () => {
    const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;
    const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
    const top = frameTopBorder("Hi", 20, cyan, dim("↑ 2"));
    expect(top.startsWith(`\u001b[36m╭─ \u001b[0m`)).toBe(true);
    expect(top).toContain(`\u001b[2m↑ 2\u001b[0m`);
    expect(top).toMatch(/\u001b\[36m ─+ \u001b\[0m/);
    expect(top.endsWith(`\u001b[36m ─╮\u001b[0m`)).toBe(true);
    expect(visibleWidth(top)).toBe(20);
  });

  it("drops the label when only the arrow fits, and the arrow only when it cannot fit at all", () => {
    // Combined layout needs width >= arrowWidth + 10; below that the
    // arrow wins the row alone.
    const withArrow = frameTopBorder("Hi", 11, identity, "↑ 2");
    expect(withArrow).toBe(`╭${"─".repeat(3)} ↑ 2 ─╮`);
    expect(visibleWidth(withArrow)).toBe(11);
    // The narrowest exact fit for a 3-wide arrow is width 9.
    expect(frameBottomBorder("", 9, identity, "↓ 4")).toBe("╰─ ↓ 4 ─╯");
    // A 4-wide arrow fits first at width 10, not 9.
    expect(frameBottomBorder("", 9, identity, "↓ 14")).toBe(
      `╰${"─".repeat(7)}╯`,
    );
    expect(frameBottomBorder("", 10, identity, "↓ 14")).toBe("╰─ ↓ 14 ─╯");
    // Below the framed-border floor everything stays plain.
    expect(frameTopBorder("Hi", 7, identity, "↑ 2")).toBe(`╭${"─".repeat(5)}╮`);
  });

  it("measures arrow-bearing borders by display width for wide text", () => {
    const top = frameTopBorder("改善提案の確認", 20, identity, "↑ 2");
    expect(visibleWidth(top)).toBe(20);
    const bottom = frameBottomBorder("改善", 20, identity, "↓ 4");
    expect(visibleWidth(bottom)).toBe(20);
  });

  it("charges three columns beyond the arrow width for the pad", () => {
    expect(arrowPad(undefined)).toBe(0);
    expect(arrowPad("")).toBe(0);
    expect(arrowPad("↑ 2")).toBe(6);
    expect(arrowPad(`\u001b[2m↑ 12\u001b[0m`)).toBe(7);
  });

  it("reports exactly when an arrow can claim the right edge", () => {
    expect(arrowFits(7, "↑ 2")).toBe(false);
    expect(arrowFits(8, "↑ 2")).toBe(false);
    expect(arrowFits(9, "↑ 2")).toBe(true);
    expect(arrowFits(9, "↑ 12")).toBe(false);
    expect(arrowFits(10, "↑ 12")).toBe(true);
    expect(arrowFits(200, undefined)).toBe(false);
  });
});

describe("sanitizeFrameText", () => {
  it("strips escape sequences and control characters and expands tabs", () => {
    expect(
      sanitizeFrameText("hello \u001b[41m\u001b[5mRED\u001b[2J tail\ttabbed"),
    ).toBe("hello RED tail    tabbed");
  });

  it("strips OSC and two-character escapes", () => {
    expect(sanitizeFrameText("a\u001b]0;title\u0007b\u001bMc")).toBe("abc");
  });

  it("keeps normal and wide text unchanged", () => {
    expect(sanitizeFrameText("plain 你 world ★ stay")).toBe(
      "plain 你 world ★ stay",
    );
  });
});

describe("frameBorderColor", () => {
  it("falls back to literal cyan when the theme applies no color", () => {
    const bare = { fg: (_c: string, t: string) => t } as never;
    const color = frameBorderColor(bare);
    expect(color("│")).toBe(`\u001b[36m│\u001b[0m`);
  });

  it("uses the theme color whenever the theme provides one", () => {
    const themed = {
      fg: (c: string, t: string) =>
        c === "borderAccent" ? `\u001b[35m${t}\u001b[0m` : t,
    } as never;
    const color = frameBorderColor(themed);
    expect(color("│")).toBe(`\u001b[35m│\u001b[0m`);
    expect(plain(color("│"))).toBe("│");
  });
});

describe("droppedStatusParts", () => {
  it("returns only the tiers missing from the fitted status", () => {
    const status = { ...full };
    expect(droppedStatusParts(status, fitStatusLabel(status, 76))).toEqual({
      count: "259 chars (+171)",
    });
    expect(droppedStatusParts(status, fitStatusLabel(status, 57))).toEqual({
      thinking: "Thinking: off",
      count: "259 chars (+171)",
    });
    expect(droppedStatusParts(status, fitStatusLabel(status, 77))).toEqual({});
  });
});
