import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImproverModelRuntime } from "./improver-model-runtime.js";
import { countGraphemes } from "./output.js";
import {
  DEFAULT_INSTRUCTION,
  type PromptImproveSettings,
} from "./settings-store.js";

const globalState = globalThis as typeof globalThis & {
  __piPromptImproveWarnedSessions?: Set<string>;
};
const warned =
  globalState.__piPromptImproveWarnedSessions ??
  (globalState.__piPromptImproveWarnedSessions = new Set<string>());

export const HIGH_CONTEXT_WARNING = (count: number) =>
  `Prompt Improver is configured to send up to ${count} recent session messages to the improver model. This may increase token usage, cost, and data shared with that model's provider.`;

export function warnHighContext(
  ctx: ExtensionContext,
  settings: PromptImproveSettings,
): void {
  if (!settings.context.enabled || settings.context.count < 20) return;
  const key = `${ctx.sessionManager.getSessionId()}:high-context`;
  if (warned.has(key)) return;
  warned.add(key);
  ctx.ui.notify(HIGH_CONTEXT_WARNING(settings.context.count), "warning");
}

export function warnOnce(
  ctx: ExtensionContext,
  category: string,
  message: string,
): void {
  const key = `${ctx.sessionManager.getSessionId()}:${category}`;
  if (warned.has(key)) return;
  warned.add(key);
  ctx.ui.notify(message, "warning");
}

export async function formatStatus(
  settings: PromptImproveSettings,
  runtime: ImproverModelRuntime,
): Promise<string> {
  const inspected = await runtime.inspect(settings);
  const thinking =
    settings.thinking === "default" ? "Model default" : settings.thinking;
  const instruction =
    settings.instruction === DEFAULT_INSTRUCTION ? "default" : "custom";
  const lines = [
    `Model: ${inspected.identity}`,
    `Thinking: ${thinking}`,
    ...(settings.fastMode ? ["Fast mode: requested"] : []),
    `Context: ${settings.context.enabled ? `on (${settings.context.count})` : `off (remembered ${settings.context.count})`}`,
    `Rewrite guidance: ${instruction} (${countGraphemes(settings.instruction).toLocaleString("en-US")} chars)`,
    "Protocol: fixed context/draft separation",
    "Shortcuts: super+i, ctrl+shift+i",
  ];
  lines.push(
    ...inspected.configurationErrors.map(
      (error) => `Configuration error: ${error}`,
    ),
  );
  return lines.join("\n");
}

export function resetWarningStateForTests(): void {
  warned.clear();
}
