import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createUiAdapter } from "../src/ui.js";

const theme = {
  fg: (color: string, text: string) =>
    color === "borderAccent" ? `\u001b[36m${text}\u001b[0m` : text,
  bold: (text: string) => text,
} as never;

/** Strip SGR color sequences for exact-match assertions. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

function uiHarness() {
  let terminalHandler:
    ((data: string) => { consume?: boolean } | undefined) | undefined;
  let component:
    | { render(width: number): string[]; handleInput?(data: string): void }
    | undefined;
  const requestRender = vi.fn();
  const setWidget = vi.fn(
    (
      _key: string,
      content:
        ((tui: unknown, widgetTheme: unknown) => typeof component) | undefined,
      _options?: unknown,
    ) => {
      component = content?.(
        { requestRender } as never,
        theme,
      ) as typeof component;
    },
  );
  const ctx = {
    ui: {
      setWidget,
      onTerminalInput: (handler: typeof terminalHandler) => {
        terminalHandler = handler;
        return vi.fn();
      },
      custom: vi.fn(() => {
        throw new Error("custom UI must not replace editor");
      }),
    },
  } as never;
  return {
    ctx,
    setWidget,
    requestRender,
    send: (data: string) => terminalHandler?.(data),
    render: (width = 100) => component?.render(width),
  };
}

describe("above-editor UI adapter", () => {
  it("owns input synchronously during setup and supports local cancellation", () => {
    const h = uiHarness();
    const setup = createUiAdapter(h.ctx).beginSetup({
      mainRunContinues: true,
    });
    const setupLines = h.render() ?? [];
    expect(plain(setupLines[0] ?? "").startsWith("╭")).toBe(true);
    expect(plain(setupLines[0] ?? "")).toContain("Preparing Prompt Improver");
    expect(plain(setupLines.join("\n"))).toContain("[Esc] to cancel");
    expect(plain(setupLines.join("\n"))).toContain(
      "Main Pi run continues · Esc cancels improvement only",
    );
    for (const line of setupLines) {
      expect(visibleWidth(line)).toBe(100);
    }
    expect(plain(setupLines.at(-1) ?? "")).toMatch(/^╰─+╯$/);
    expect(h.send("r")).toEqual({ consume: true });
    expect(h.send("\x1b[105;9u")).toEqual({ consume: true });
    expect(setup.signal.aborted).toBe(false);
    h.send("\x1b");
    expect(setup.signal.aborted).toBe(true);
    setup.dispose();
    expect(h.setWidget).toHaveBeenLastCalledWith("prompt-improve", undefined);
  });

  it("frames the generation loader with its status in the border", async () => {
    const h = uiHarness();
    let finish!: (value: string) => void;
    const result = createUiAdapter(h.ctx).runWithLoader(
      { identity: "p/m", context: 4 },
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const lines = h.render() ?? [];
    expect(plain(lines[0] ?? "").startsWith("╭")).toBe(true);
    expect(plain(lines[0] ?? "")).toContain("Improving prompt · p/m");
    expect(plain(lines.join("\n"))).toContain("Context: 4 messages");
    expect(plain(lines.join("\n"))).toContain("[Esc] to cancel");
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(100);
    }
    finish("done");
    await expect(result).resolves.toEqual({ kind: "success", value: "done" });
  });

  it("wraps loader detail rows instead of truncating them at narrow widths", async () => {
    const h = uiHarness();
    let finish!: (value: string) => void;
    const result = createUiAdapter(h.ctx).runWithLoader(
      { identity: "p/m", context: 4, mainRunContinues: true },
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const lines = (h.render(44) ?? []).map(plain).join("\n");
    expect(lines).toContain("Main Pi run continues ·");
    expect(lines).toContain("Esc cancels");
    expect(lines).toContain("improvement only");
    expect(lines).toContain("Context: 4 messages");
    for (const line of h.render(44) ?? []) {
      expect(visibleWidth(line)).toBe(44);
    }
    finish("done");
    await expect(result).resolves.toEqual({ kind: "success", value: "done" });
  });

  it("re-homes loader status tiers and keeps detail chips whole at narrow widths", async () => {
    const h = uiHarness();
    let finish!: (value: string) => void;
    const result = createUiAdapter(h.ctx).runWithLoader(
      { identity: "openai-codex/gpt-5.6-sol", context: 4 },
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const lines = (h.render(24) ?? []).map(plain);
    // Budget 24-6-2 = 16 fits only the primary; the model must reappear
    // inside the frame, wrapped rather than truncated.
    expect(lines[0]).toContain("Improving prompt");
    expect(lines[0]).not.toContain("gpt");
    const inner = lines.slice(1).join("\n");
    expect(inner).toContain("openai-codex/gpt-5.");
    expect(inner).toContain("-sol");
    expect(inner).toContain("Context: 4 messages");
    expect(inner).toContain("[Esc] to cancel");
    for (const line of h.render(24) ?? []) {
      expect(visibleWidth(line)).toBe(24);
    }
    finish("done");
    await expect(result).resolves.toEqual({ kind: "success", value: "done" });
  });

  it("shows confirmation above editor and consumes Enter without replacing editor UI", async () => {
    const h = uiHarness();
    const adapter = createUiAdapter(h.ctx);
    const result = adapter.preview({
      identity: "p/m",
      thinking: "medium",
      original: "original draft",
      improved: "improved draft",
    });

    expect(h.setWidget).toHaveBeenCalledWith(
      "prompt-improve",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(h.render()?.join("\n")).toContain("improved draft");
    expect(h.send("\r")).toEqual({ consume: true });
    await expect(result).resolves.toBe("replace");
    expect(h.setWidget).toHaveBeenLastCalledWith("prompt-improve", undefined);
  });

  it("returns Retry from confirmation while keeping editor UI intact", async () => {
    const h = uiHarness();
    const result = createUiAdapter(h.ctx).preview({
      identity: "p/m",
      thinking: "high",
      original: "original",
      improved: "first attempt",
    });

    expect(h.send("r")).toEqual({ consume: true });
    await expect(result).resolves.toBe("retry");
    expect(h.setWidget).toHaveBeenLastCalledWith("prompt-improve", undefined);
  });

  it("maps the invocation shortcut to Retry while confirmation is visible", async () => {
    const h = uiHarness();
    const result = createUiAdapter(h.ctx).preview({
      identity: "p/m",
      thinking: "high",
      original: "original",
      improved: "first attempt",
    });

    expect(h.send("\x1b[105;9u")).toEqual({ consume: true });
    await expect(result).resolves.toBe("retry");
  });

  it("moves preview actions into the bottom border with scroll arrows", async () => {
    const h = uiHarness();
    const many = Array.from({ length: 22 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    const result = createUiAdapter(h.ctx).preview({
      identity: "p/m",
      thinking: "high",
      original: "original",
      improved: many,
    });

    const before = h.render(90) ?? [];
    expect(plain(before[0] ?? "")).not.toContain("↑");
    expect(plain(before.at(-1) ?? "")).toContain(
      "↵ Replace · R ⌘I ^I Retry · Esc Keep",
    );

    h.send("\x1b[B");
    h.send("\x1b[B");

    const after = h.render(90) ?? [];
    expect(plain(after[0] ?? "")).toContain("↑ 2");
    expect(plain(after.at(-1) ?? "")).toContain("↓ 2");
    for (const line of after) {
      expect(visibleWidth(line)).toBe(90);
    }

    h.send("\x1b");
    await expect(result).resolves.toBe("keep");
  });

  it("keeps retry keys visible through the adapter at narrow widths", async () => {
    const h = uiHarness();
    const result = createUiAdapter(h.ctx).preview({
      identity: "p/m",
      thinking: "high",
      original: "original",
      improved: "improved",
    });

    const rows = h.render(20) ?? [];
    for (const line of rows) {
      expect(visibleWidth(line)).toBe(20);
    }
    expect(plain(rows.join("")).replace(/[\s│─╭╮╰╯]/g, "")).toContain("R⌘I^I");

    h.send("\x1b");
    await expect(result).resolves.toBe("keep");
  });

  it("explains concurrent main-run behavior in loader and preview", async () => {
    const loader = uiHarness();
    const loaderResult = createUiAdapter(loader.ctx).runWithLoader(
      { identity: "p/m", context: "off", mainRunContinues: true },
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    expect(loader.render()?.join("\n")).toContain(
      "Main Pi run continues · Esc cancels improvement only",
    );
    loader.send("\x1b");
    await loaderResult;

    const preview = uiHarness();
    const previewResult = createUiAdapter(preview.ctx).preview({
      identity: "p/m",
      thinking: "default",
      original: "original",
      improved: "improved",
      mainRunContinues: true,
    });
    expect(preview.render()?.join("\n")).toContain(
      "Main Pi run continues; improved text has not been submitted",
    );
    preview.send("\x1b");
    await previewResult;
  });

  it("silently consumes retry keys while loader is working", async () => {
    const h = uiHarness();
    let finish!: (value: string) => void;
    const task = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const result = createUiAdapter(h.ctx).runWithLoader(
      { identity: "p/m", context: "off", mainRunContinues: true },
      task,
    );

    expect(h.send("r")).toEqual({ consume: true });
    expect(h.send("\x1b[105;9u")).toEqual({ consume: true });
    expect(h.send("\x1b[105;6u")).toEqual({ consume: true });
    expect(task).toHaveBeenCalledTimes(1);
    finish("done");
    await expect(result).resolves.toEqual({ kind: "success", value: "done" });
  });

  it("keeps loader above editor and Escape cancels while consuming input", async () => {
    const h = uiHarness();
    const adapter = createUiAdapter(h.ctx);
    const result = adapter.runWithLoader(
      { identity: "p/m", context: "off" },
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );

    expect(h.send("\x1b")).toEqual({ consume: true });
    await expect(result).resolves.toEqual({ kind: "cancelled" });
    expect(h.setWidget).toHaveBeenLastCalledWith("prompt-improve", undefined);
  });

  it("ignores Ctrl+C release/repeat packets in preview", async () => {
    const h = uiHarness();
    const result = createUiAdapter(h.ctx).preview({
      identity: "p/m",
      thinking: "default",
      original: "original",
      improved: "improved",
      mainRunContinues: true,
    });

    h.send("\x1b[99;5:3u");
    h.send("\x1b[99;5:2u");
    h.send("\r");

    await expect(result).resolves.toBe("replace");
  });

  it("supports Ctrl+C as safe cancellation and Keep fallback", async () => {
    const loader = uiHarness();
    const loaderResult = createUiAdapter(loader.ctx).runWithLoader(
      { identity: "p/m", context: "off" },
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    expect(loader.send("\x03")).toEqual({ consume: true });
    await expect(loaderResult).resolves.toEqual({ kind: "cancelled" });

    const preview = uiHarness();
    const previewResult = createUiAdapter(preview.ctx).preview({
      identity: "p/m",
      thinking: "default",
      original: "original",
      improved: "improved",
    });
    expect(preview.send("\x03")).toEqual({ consume: true });
    await expect(previewResult).resolves.toBe("keep");
  });
});
