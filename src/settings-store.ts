import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_INSTRUCTION =
  "Improve the user's draft prompt for clarity and effectiveness. Preserve its intent, constraints, technical details, tone, formatting, paths, commands, and code. Do not answer the prompt or invent requirements. Return only the improved prompt.";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingSetting = "default" | ThinkingLevel;

export type ModelSetting =
  { mode: "active" } | { mode: "fixed"; provider: string; model: string };

export interface PromptImproveSettings {
  version: 2;
  model: ModelSetting;
  thinking: ThinkingSetting;
  instruction: string;
  context: { enabled: boolean; count: number };
  fastMode: boolean;
}

export type SettingsLoadResult =
  { ok: true; settings: PromptImproveSettings } | { ok: false; error: string };

export function defaultSettings(): PromptImproveSettings {
  return {
    version: 2,
    model: { mode: "active" },
    thinking: "default",
    instruction: DEFAULT_INSTRUCTION,
    context: { enabled: false, count: 4 },
    fastMode: false,
  };
}

function parseSettings(value: unknown): PromptImproveSettings {
  if (!value || typeof value !== "object")
    throw new Error("settings must be an object");
  const data = value as Record<string, unknown>;
  const version = data.version;
  if (version !== 1 && version !== 2)
    throw new Error("unsupported settings version");
  assertKeys(
    data,
    version === 1
      ? ["version", "model", "thinking", "instruction", "context"]
      : ["version", "model", "thinking", "instruction", "context", "fastMode"],
    "settings",
  );

  const model = data.model as Record<string, unknown> | undefined;
  let parsedModel: ModelSetting;
  if (model?.mode === "active") {
    assertKeys(model, ["mode"], "active model");
    parsedModel = { mode: "active" };
  } else if (
    model?.mode === "fixed" &&
    typeof model.provider === "string" &&
    model.provider.length > 0 &&
    typeof model.model === "string" &&
    model.model.length > 0
  ) {
    assertKeys(model, ["mode", "provider", "model"], "fixed model");
    parsedModel = {
      mode: "fixed",
      provider: model.provider,
      model: model.model,
    };
  } else {
    throw new Error("model configuration is invalid");
  }

  if (
    data.thinking !== "default" &&
    !THINKING_LEVELS.includes(data.thinking as ThinkingLevel)
  ) {
    throw new Error("thinking configuration is invalid");
  }
  if (
    typeof data.instruction !== "string" ||
    data.instruction.trim().length === 0
  ) {
    throw new Error("rewrite guidance must not be blank");
  }
  if (version === 2 && typeof data.fastMode !== "boolean") {
    throw new Error("fast mode must be boolean");
  }
  const context = data.context as Record<string, unknown> | undefined;
  if (context) assertKeys(context, ["enabled", "count"], "context");
  if (typeof context?.enabled !== "boolean")
    throw new Error("context enabled must be boolean");
  if (!Number.isSafeInteger(context.count) || (context.count as number) <= 0) {
    throw new Error("context count must be a positive integer");
  }

  return {
    version: 2,
    model: parsedModel,
    thinking: data.thinking as ThinkingSetting,
    instruction: data.instruction,
    context: { enabled: context.enabled, count: context.count as number },
    fastMode: version === 2 ? (data.fastMode as boolean) : false,
  };
}

export interface SettingsStoreHooks {
  beforeRename?: () => void | Promise<void>;
}

export class SettingsStore {
  constructor(
    readonly path: string,
    private readonly hooks: SettingsStoreHooks = {},
  ) {}

  async load(): Promise<SettingsLoadResult> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, settings: defaultSettings() };
      }
      return { ok: false, error: `Cannot read settings: ${messageOf(error)}` };
    }

    try {
      return { ok: true, settings: parseSettings(JSON.parse(text)) };
    } catch (error) {
      return {
        ok: false,
        error: `Malformed settings file: ${error instanceof SyntaxError ? "invalid JSON" : messageOf(error)}`,
      };
    }
  }

  async save(settings: PromptImproveSettings): Promise<void> {
    const validated = parseSettings(settings);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await this.hooks.beforeRename?.();
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      const dirHandle = await open(directory, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unknown field: ${unknown.join(", ")}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
