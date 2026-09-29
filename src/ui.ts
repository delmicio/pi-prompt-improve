import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { previewStatus } from "./output.js";
import {
  arrowFits,
  arrowPad,
  droppedStatusParts,
  droppedStatusRows,
  fitStatusLabel,
  frameBorderColor,
  frameBottomBorder,
  frameContentWidth,
  frameRow,
  frameTopBorder,
  labelBudget,
  sanitizeFrameText,
  styleStatus,
  type FittedStatus,
} from "./frame.js";
import type { CoordinatorDeps } from "./coordinator.js";
import type { ThinkingSetting } from "./settings-store.js";
import { matchesImproveShortcut } from "./shortcuts.js";

const WIDGET_KEY = "prompt-improve";

type PreviewDecision = "replace" | "keep" | "retry";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const SPINNER_INTERVAL_MS = 100;

/**
 * Wrap lines to the frame's content width, keeping at least one row.
 * Continuation rows can carry an unbalanced SGR state, so every styled
 * row ends with a reset to stop attributes bleeding into the border.
 */
function wrapRows(text: string, contentWidth: number): string[] {
  const wrapped = wrapTextWithAnsi(text, contentWidth);
  const rows = wrapped.length > 0 ? wrapped : [""];
  return rows.map((row) => (row.includes("\u001b[") ? `${row}\u001b[0m` : row));
}

/**
 * Lay out action-hint segments as one bottom bar: joined with wide gaps on
 * a single row, wrapped to continuation rows only when the bar is too
 * narrow — always at segment boundaries, never truncating a segment.
 */
function actionBarRows(
  segments: readonly string[],
  contentWidth: number,
): string[] {
  const gap = "   ";
  const rows: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current.length > 0 ? current + gap + segment : segment;
    if (visibleWidth(segment) > contentWidth) {
      if (current.length > 0) rows.push(current);
      rows.push(...wrapRows(segment, contentWidth));
      current = "";
    } else if (
      current.length === 0 ||
      visibleWidth(candidate) <= contentWidth
    ) {
      current = candidate;
    } else {
      rows.push(current);
      current = segment;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [""];
}

/**
 * Loader inside the Prompt Improver frame. The spinner animation is owned
 * locally so the widget depends only on public pi-tui interfaces; the
 * status sits in the top border, mirroring the preview.
 */
class FramedLoader implements Component {
  private readonly border: (s: string) => string;
  private frameIndex = 0;
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    tui: TUI,
    private readonly theme: Theme,
    private readonly label: FittedStatus,
    private readonly chips: readonly string[],
    private readonly note: string | undefined,
  ) {
    this.border = frameBorderColor(theme);
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      tui.requestRender();
    }, SPINNER_INTERVAL_MS);
    // The animation must never keep the host process alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
  }

  render(width: number): string[] {
    const contentWidth = frameContentWidth(width);
    const fitted = fitStatusLabel(
      this.label,
      Math.max(0, labelBudget(width) - 2),
    );
    const label = `${this.theme.fg(
      "accent",
      SPINNER_FRAMES[this.frameIndex] ?? "",
    )} ${styleStatus(this.theme, fitted)}`;
    const rows: string[] = [""];
    const dropped = droppedStatusParts(this.label, fitted);
    rows.push(...droppedStatusRows(this.theme, dropped, contentWidth));
    rows.push(...actionBarRows(this.chips, contentWidth));
    if (this.note) rows.push(...wrapRows(this.note, contentWidth));
    rows.push("");
    return [
      frameTopBorder(label, width, this.border),
      ...rows.map((line) => frameRow(line, width, this.border)),
      frameBottomBorder("", width, this.border),
    ];
  }

  handleInput(): void {}

  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function loaderDetails(
  theme: Theme,
  first: string,
  mainRunContinues: boolean,
): { chips: string[]; note: string | undefined } {
  const cancel = `${theme.fg("accent", "[Esc]")} ${theme.fg("dim", "to cancel")}`;
  const chips = first.length > 0 ? [first, cancel] : [cancel];
  return {
    chips,
    note: mainRunContinues
      ? theme.fg(
          "warning",
          "Main Pi run continues · Esc cancels improvement only",
        )
      : undefined,
  };
}

/**
 * Confirmation actions for the bottom border, degrading right-first:
 * labeled actions, then the Esc/Replace labels drop, then only key
 * glyphs remain. A border is a single line by construction, so the ladder
 * never wraps and never drops a retry key; it returns undefined when even
 * the glyph form exceeds the budget and the caller re-homes the full
 * actions to body rows instead.
 */
function bottomActionLabel(theme: Theme, budget: number): string | undefined {
  const separator = theme.fg("dim", " · ");
  const candidates = [
    [
      theme.fg("accent", "↵ Replace"),
      theme.fg("accent", "R ⌘I ^I Retry"),
      theme.fg("dim", "Esc Keep"),
    ],
    [
      theme.fg("accent", "↵ Replace"),
      theme.fg("accent", "R ⌘I ^I"),
      theme.fg("dim", "Esc"),
    ],
    [
      theme.fg("accent", "↵"),
      theme.fg("accent", "R ⌘I ^I"),
      theme.fg("dim", "Esc"),
    ],
  ];
  for (const parts of candidates) {
    const label = parts.join(separator);
    if (visibleWidth(label) <= budget) return label;
  }
  return undefined;
}

/**
 * Body-row fallback for widths where no border form of the actions fits;
 * segments wrap at boundaries so every retry key stays visible.
 */
function actionFallbackRows(theme: Theme, contentWidth: number): string[] {
  return actionBarRows(
    [
      theme.fg("accent", "↵ Replace"),
      theme.fg("accent", "R ⌘I ^I Retry"),
      theme.fg("dim", "Esc Keep"),
    ],
    contentWidth,
  );
}

export class PreviewComponent implements Component {
  readonly source: string;
  private offset = 0;
  private lastBody: string[] = [];

  constructor(
    private readonly input: {
      identity: string;
      thinking: ThinkingSetting;
      original: string;
      improved: string;
      mainRunContinues?: boolean;
    },
    private readonly theme: Theme,
    private readonly done: (decision: PreviewDecision) => void,
    private readonly viewportHeight = 18,
  ) {
    this.source = input.improved;
  }

  render(width: number): string[] {
    const border = frameBorderColor(this.theme);
    const contentWidth = frameContentWidth(width);
    const body = this.source
      .split("\n")
      .flatMap((line) => wrapRows(sanitizeFrameText(line), contentWidth));
    this.lastBody = body;
    const maxOffset = Math.max(0, body.length - this.viewportHeight);
    this.offset = Math.min(this.offset, maxOffset);
    const above = this.offset;
    const below = body.length - (this.offset + this.viewportHeight);
    const visible = body.slice(this.offset, this.offset + this.viewportHeight);
    const topArrow =
      above > 0 && arrowFits(width, `↑ ${above}`)
        ? this.theme.fg("dim", `↑ ${above}`)
        : undefined;
    const bottomArrow =
      below > 0 && arrowFits(width, `↓ ${below}`)
        ? this.theme.fg("dim", `↓ ${below}`)
        : undefined;

    const fullStatus: FittedStatus = previewStatus(
      this.input.identity,
      this.input.thinking,
      this.input.original,
      this.input.improved,
    );
    const fitted = fitStatusLabel(
      fullStatus,
      labelBudget(width) - arrowPad(topArrow),
    );
    const dropped = droppedStatusParts(fullStatus, fitted);
    const actions = bottomActionLabel(
      this.theme,
      labelBudget(width) - arrowPad(bottomArrow),
    );

    const inner: string[] = [];
    inner.push(...droppedStatusRows(this.theme, dropped, contentWidth));

    inner.push("");
    inner.push(...visible.map((line) => this.theme.fg("text", line)));
    inner.push("");
    if (this.input.mainRunContinues) {
      inner.push(
        ...wrapRows(
          this.theme.fg(
            "warning",
            "Main Pi run continues; improved text has not been submitted",
          ),
          contentWidth,
        ),
      );
    }
    if (actions === undefined) {
      inner.push(...actionFallbackRows(this.theme, contentWidth));
    }
    inner.push(
      ...wrapRows(
        this.theme.fg("dim", "Original remains visible below"),
        contentWidth,
      ),
    );
    return [
      frameTopBorder(styleStatus(this.theme, fitted), width, border, topArrow),
      ...inner.map((line) => frameRow(line, width, border)),
      frameBottomBorder(actions ?? "", width, border, bottomArrow),
    ];
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const repeat = isKeyRepeat(data);
    if (
      !repeat &&
      (matchesImproveShortcut(data) ||
        matchesKey(data, "r") ||
        matchesKey(data, "shift+r"))
    ) {
      this.done("retry");
      return;
    }
    if (!repeat && matchesKey(data, Key.enter)) {
      this.done("replace");
      return;
    }
    if (!repeat && matchesKey(data, Key.escape)) {
      this.done("keep");
      return;
    }
    const maxOffset = Math.max(0, this.lastBody.length - this.viewportHeight);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down))
      this.offset = Math.min(maxOffset, this.offset + 1);
    else if (matchesKey(data, Key.pageUp))
      this.offset = Math.max(0, this.offset - this.viewportHeight);
    else if (matchesKey(data, Key.pageDown))
      this.offset = Math.min(maxOffset, this.offset + this.viewportHeight);
  }

  invalidate(): void {}
}

type LoaderResult<T> =
  | { kind: "success"; value: T }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

function beginSetup(
  ctx: ExtensionContext,
  metadata: { mainRunContinues?: boolean },
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      const { chips, note } = loaderDetails(
        theme,
        "",
        Boolean(metadata.mainRunContinues),
      );
      return new FramedLoader(
        tui,
        theme,
        { primary: "Preparing Prompt Improver" },
        chips,
        note,
      );
    },
    { placement: "aboveEditor" },
  );
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (
      !isKeyRelease(data) &&
      !isKeyRepeat(data) &&
      (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
    ) {
      controller.abort();
    }
    return { consume: true };
  });
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    },
  };
}

async function runLoader<T>(
  ctx: ExtensionContext,
  metadata: {
    identity: string;
    context: "off" | number;
    mainRunContinues?: boolean;
  },
  task: (signal: AbortSignal) => Promise<T>,
): Promise<LoaderResult<T>> {
  const controller = new AbortController();
  const context =
    metadata.context === "off"
      ? "Context: off"
      : `Context: ${metadata.context} messages`;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      const { chips, note } = loaderDetails(
        theme,
        theme.fg("muted", context),
        Boolean(metadata.mainRunContinues),
      );
      return new FramedLoader(
        tui,
        theme,
        { primary: "Improving prompt", model: metadata.identity },
        chips,
        note,
      );
    },
    { placement: "aboveEditor" },
  );
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (
      !isKeyRelease(data) &&
      !isKeyRepeat(data) &&
      (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
    ) {
      controller.abort();
    }
    return { consume: true };
  });
  const cancelled = new Promise<symbol>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(CANCELLED), {
      once: true,
    });
  });

  try {
    const result = await Promise.race([task(controller.signal), cancelled]);
    return result === CANCELLED
      ? { kind: "cancelled" }
      : { kind: "success", value: result as T };
  } catch (error) {
    return controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
      ? { kind: "cancelled" }
      : { kind: "error", error };
  } finally {
    unsubscribe();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

const CANCELLED = Symbol("cancelled");

function showPreview(
  ctx: ExtensionContext,
  input: {
    identity: string;
    thinking: ThinkingSetting;
    original: string;
    improved: string;
    mainRunContinues?: boolean;
  },
): Promise<PreviewDecision> {
  return new Promise((resolve) => {
    let component: PreviewComponent | undefined;
    let requestRender = () => {};
    let unsubscribe = () => {};
    let settled = false;
    const finish = (decision: PreviewDecision) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      resolve(decision);
    };

    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        component = new PreviewComponent(input, theme, finish);
        return component;
      },
      { placement: "aboveEditor" },
    );
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (
        !isKeyRelease(data) &&
        !isKeyRepeat(data) &&
        matchesKey(data, Key.ctrl("c"))
      ) {
        finish("keep");
      } else component?.handleInput(data);
      requestRender();
      return { consume: true };
    });
  });
}

export function createUiAdapter(ctx: ExtensionContext): CoordinatorDeps["ui"] {
  return {
    beginSetup: (metadata) => beginSetup(ctx, metadata),
    runWithLoader: (metadata, task) => runLoader(ctx, metadata, task),
    preview: (input) => showPreview(ctx, input),
  };
}
