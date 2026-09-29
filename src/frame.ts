import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Character-grid frame for Prompt Improver widgets.
 *
 * Every color resolves through the caller's theme, so the frame always
 * follows the user's theme; the only literal color is the defensive cyan
 * fallback for a theme that provides no borderAccent color.
 */

const SEPARATOR = " · ";
const ELLIPSIS = "…";
const CYAN = (s: string) => `\u001b[36m${s}\u001b[0m`;

export interface StatusTiers {
  primary?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  count?: string | undefined;
}

export interface FittedStatus extends StatusTiers {
  primary: string;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(SEPARATOR);
}

/** Truncate by display width so wide characters never break the frame. */
function ellipsize(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  // sliceByColumn keeps whole wide characters and may overshoot the
  // requested column count, so shrink until the result plus ellipsis fits.
  for (let keep = maxWidth - 1; keep > 0; keep--) {
    const slice = sliceByColumn(text, 0, keep);
    if (visibleWidth(slice) + ELLIPSIS.length <= maxWidth) {
      return slice + ELLIPSIS;
    }
  }
  return ELLIPSIS;
}

/**
 * Fit a status label to a border budget by dropping tiers in priority order:
 * count first, then thinking, then ellipsizing the model. The primary label
 * is truncated only when nothing else fits.
 */
export function fitStatusLabel(
  label: FittedStatus,
  maxWidth: number,
): FittedStatus {
  // Measure what will actually render: styleStatus sanitizes each tier,
  // and sanitization can change width (tabs expand), so budgets computed
  // on raw text could overshoot the border.
  const clean: FittedStatus = {
    primary: sanitizeFrameText(label.primary),
    model:
      label.model === undefined ? undefined : sanitizeFrameText(label.model),
    thinking:
      label.thinking === undefined
        ? undefined
        : sanitizeFrameText(label.thinking),
    count:
      label.count === undefined ? undefined : sanitizeFrameText(label.count),
  };
  label = clean;
  if (
    visibleWidth(
      joinParts([label.primary, label.model, label.thinking, label.count]),
    ) <= maxWidth
  ) {
    return { ...label };
  }
  if (
    visibleWidth(joinParts([label.primary, label.model, label.thinking])) <=
    maxWidth
  ) {
    const { count: _count, ...rest } = label;
    return rest;
  }
  if (visibleWidth(joinParts([label.primary, label.model])) <= maxWidth) {
    const { count: _count, thinking: _thinking, ...rest } = label;
    return rest;
  }
  const modelRoom = maxWidth - visibleWidth(label.primary) - SEPARATOR.length;
  if (modelRoom >= ELLIPSIS.length) {
    return {
      primary: label.primary,
      model: label.model ? ellipsize(label.model, modelRoom) : undefined,
    };
  }
  return { primary: ellipsize(label.primary, maxWidth) };
}

/**
 * Tiers present in the full status but missing from the fitted label, for
 * re-homing inside the frame so required header data is always visible.
 */
export function droppedStatusParts(
  status: FittedStatus,
  fitted: FittedStatus,
): StatusTiers {
  const dropped: StatusTiers = {};
  for (const key of ["model", "thinking", "count"] as const) {
    if (status[key] !== undefined && fitted[key] === undefined) {
      dropped[key] = status[key];
    }
  }
  return dropped;
}

/** Hard-wrap by display width, breaking anywhere — for unbreakable tokens. */
function hardWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const ch of Array.from(text)) {
    const charWidth = visibleWidth(ch) || 1;
    if (used + charWidth > width && row.length > 0) {
      rows.push(row);
      row = ch;
      used = charWidth;
    } else {
      row += ch;
      used += charWidth;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows.length > 0 ? rows : [""];
}

/**
 * Re-homed dropped tiers as ready-to-frame rows: plain text hard-wrapped so
 * long model identifiers never lose characters to ellipsis.
 */
export function droppedStatusRows(
  theme: Theme,
  dropped: StatusTiers,
  contentWidth: number,
): string[] {
  const parts = [dropped.model, dropped.thinking, dropped.count].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (parts.length === 0) return [];
  return hardWrap(
    sanitizeFrameText(parts.join(SEPARATOR)),
    Math.max(1, contentWidth),
  ).map((row) => theme.fg("muted", row));
}

/** Budget for a label set into a top border of the given width. */
export function labelBudget(width: number): number {
  return width - 6;
}

/**
 * Columns a right-edge arrow steals from the border label budget: the
 * arrow itself plus its surrounding spaces and trailing dash.
 */
export function arrowPad(arrow: string | undefined): number {
  const arrowWidth = arrow === undefined ? 0 : visibleWidth(arrow);
  return arrowWidth > 0 ? arrowWidth + 3 : 0;
}

/**
 * Whether an arrow can claim the right edge of a border row at all:
 * the arrow-only layout needs one leading dash plus its fixed frame
 * columns. Callers shrink the label budget only when this holds, so
 * budget math and rendering never disagree.
 */
export function arrowFits(width: number, arrow: string | undefined): boolean {
  if (arrow === undefined || arrow.length === 0) return false;
  const arrowWidth = visibleWidth(arrow);
  return width >= 8 && width - arrowWidth - 6 >= 0;
}

/** Content width available between the frame's side columns. */
export function frameContentWidth(width: number): number {
  return Math.max(0, width - 4);
}

const ANSI_SEQUENCE =
  /\u001b(?:\[[0-9;:?<=> -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Render-safe text for the frame: model output may contain escape
 * sequences or tabs that would corrupt the frame geometry or hijack the
 * terminal, so they are neutralized before any styling is applied.
 */
export function sanitizeFrameText(text: string): string {
  return text
    .replace(/\t/g, "    ")
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARS, "");
}

/**
 * Style a status in tiers: primary in bold accent, model and thinking in
 * muted, count in text color, separators in dim. All colors come from the
 * user's theme. Empty fields are skipped, so this also styles partial
 * (dropped-tier) statuses.
 */
export function styleStatus(theme: Theme, tiers: StatusTiers): string {
  const parts: string[] = [];
  if (tiers.primary)
    parts.push(
      theme.bold(theme.fg("accent", sanitizeFrameText(tiers.primary))),
    );
  if (tiers.model)
    parts.push(theme.fg("muted", sanitizeFrameText(tiers.model)));
  if (tiers.thinking)
    parts.push(theme.fg("muted", sanitizeFrameText(tiers.thinking)));
  if (tiers.count) parts.push(theme.fg("text", sanitizeFrameText(tiers.count)));
  return parts.join(theme.fg("dim", SEPARATOR));
}

/**
 * Border color from the user's theme, falling back to literal cyan only
 * when the theme applies no color.
 */
export function frameBorderColor(
  theme: Pick<Theme, "fg">,
): (s: string) => string {
  return (s: string) => {
    const themed = theme.fg("borderAccent", s);
    return themed === s ? CYAN(s) : themed;
  };
}

/**
 * Shared layout for a labeled border row. The optional arrow is embedded
 * at the extreme right (`─ ↑ 2 ─╮`); when label and arrow cannot both
 * fit, the arrow wins the right edge and the label budget shrinks. Each
 * border segment is colored separately so ANSI resets inside the label
 * or arrow cannot strip color from the rest of the row.
 */
function frameBorderRow(
  openCorner: string,
  closeCorner: string,
  label: string,
  width: number,
  border: (s: string) => string,
  arrow?: string,
): string {
  if (width < 8) {
    return border(
      `${openCorner}${"─".repeat(Math.max(0, width - 2))}${closeCorner}`,
    );
  }
  const labelWidth = visibleWidth(label);
  const arrowWidth = arrow === undefined ? 0 : visibleWidth(arrow);
  if (arrowWidth > 0) {
    if (labelWidth > 0 && width - arrowWidth - 9 >= 1) {
      const text = ellipsize(label, width - arrowWidth - 9);
      const dashes = width - visibleWidth(text) - arrowWidth - 8;
      return `${border(`${openCorner}─ `)}${text}${border(` ${"─".repeat(Math.max(1, dashes))} `)}${arrow}${border(` ─${closeCorner}`)}`;
    }
    // The arrow wins the right edge: when label and arrow cannot share
    // the row, keep the arrow alone rather than dropping it for a label.
    if (width - arrowWidth - 6 >= 0) {
      const dashes = width - arrowWidth - 5;
      return `${border(`${openCorner}${"─".repeat(Math.max(1, dashes))} `)}${arrow}${border(` ─${closeCorner}`)}`;
    }
  }
  if (labelWidth > 0) {
    const budget = labelBudget(width);
    const text = ellipsize(label, budget);
    const dashes = width - visibleWidth(text) - 5;
    return `${border(`${openCorner}─ `)}${text}${border(` ${"─".repeat(Math.max(1, dashes))}${closeCorner}`)}`;
  }
  return border(
    `${openCorner}${"─".repeat(Math.max(0, width - 2))}${closeCorner}`,
  );
}

/**
 * Top border `╭─ label ─── ↑ 2 ─╮`. The label may contain ANSI styling;
 * see {@link frameBorderRow} for the layout rules.
 */
export function frameTopBorder(
  label: string,
  width: number,
  border: (s: string) => string,
  arrow?: string,
): string {
  return frameBorderRow("╭", "╮", label, width, border, arrow);
}

/** Content row `│ content │` padded and truncated to the frame width. */
export function frameRow(
  line: string,
  width: number,
  border: (s: string) => string,
): string {
  const contentWidth = frameContentWidth(width);
  if (width < 4) {
    return border(ellipsize(line, width));
  }
  const content = ellipsize(line, contentWidth);
  const pad = Math.max(0, contentWidth - visibleWidth(content));
  return `${border("│")} ${content}${" ".repeat(pad)} ${border("│")}`;
}

/** Bottom border `╰─ label ─── ↓ 4 ─╯`; empty label renders a plain or
 * arrow-only row. */
export function frameBottomBorder(
  label: string,
  width: number,
  border: (s: string) => string,
  arrow?: string,
): string {
  return frameBorderRow("╰", "╯", label, width, border, arrow);
}
