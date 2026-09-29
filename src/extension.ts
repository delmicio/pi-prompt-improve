import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { OperationCoordinator } from "./coordinator.js";
import { ImproverModelRuntime } from "./improver-model-runtime.js";
import { assertPromptImproverPiSupport } from "./pi-compat.js";
import { redactError } from "./redact.js";
import { defaultSettings, SettingsStore } from "./settings-store.js";
import { showSettings } from "./settings-ui.js";
import { IMPROVE_SHORTCUTS } from "./shortcuts.js";
import { formatStatus, warnHighContext, warnOnce } from "./status.js";
import { createUiAdapter } from "./ui.js";

export interface ExtensionOptions {
  homeDirectory?: string;
}

export default function promptImproveExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions = {},
): void {
  const settingsPath = join(
    options.homeDirectory ?? homedir(),
    ".pi",
    "agent",
    "prompt-improve.json",
  );
  const store = new SettingsStore(settingsPath);
  let operationRunning = false;
  let sessionEpoch = 0;

  const improve = async (ctx: ExtensionContext) => {
    if (operationRunning) return;
    operationRunning = true;
    const activeModelAtInvocation = ctx.model;
    try {
      assertPromptImproverPiSupport(ctx.modelRegistry);
      const runtime = new ImproverModelRuntime(
        ctx.modelRegistry,
        () => activeModelAtInvocation,
      );
      const coordinator = new OperationCoordinator({
        runtime: {
          mode: () => ctx.mode,
          isIdle: () => ctx.isIdle(),
          getDraft: () => ctx.ui.getEditorText(),
          setDraft: (text) => ctx.ui.setEditorText(text),
          notify: (message, type) => ctx.ui.notify(message, type),
          getActiveContextEntries: () =>
            ctx.sessionManager.buildContextEntries(),
        },
        settings: store,
        improverModel: runtime,
        ui: createUiAdapter(ctx),
      });
      await coordinator.run();
    } finally {
      operationRunning = false;
    }
  };

  for (const shortcut of IMPROVE_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Improve current editor draft",
      handler: improve,
    });
  }

  pi.registerCommand("prompt-improve", {
    description: "Configure Prompt Improver or show status/reset defaults",
    getArgumentCompletions(prefix) {
      const values = ["status", "reset"].filter((value) =>
        value.startsWith(prefix.trim()),
      );
      return values.length
        ? values.map((value) => ({ value, label: value }))
        : null;
    },
    async handler(rawArgs, ctx) {
      const args = rawArgs.trim();
      assertPromptImproverPiSupport(ctx.modelRegistry);
      const runtime = new ImproverModelRuntime(
        ctx.modelRegistry,
        () => ctx.model,
      );

      if (args === "status") {
        const loaded = await store.load();
        if (!loaded.ok) {
          ctx.ui.notify(
            `Prompt Improver status\nConfiguration error: ${redactError(loaded.error)}\nSettings: ${settingsPath}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(await formatStatus(loaded.settings, runtime), "info");
        return;
      }

      if (args === "reset") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Prompt Improver reset requires interactive TUI mode",
            "error",
          );
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify(
            "Prompt Improver reset requires Pi to be idle",
            "warning",
          );
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Reset Prompt Improver?",
          "Restore active model, Model default thinking, Fast mode off, built-in rewrite guidance, context off, and N = 4?",
        );
        if (!confirmed) return;
        try {
          await store.save(defaultSettings());
          ctx.ui.notify("Prompt Improver settings reset", "info");
        } catch (error) {
          ctx.ui.notify(
            `Prompt Improver reset failed: ${redactError(error)}`,
            "error",
          );
        }
        return;
      }

      if (args.length > 0) {
        ctx.ui.notify("Usage: /prompt-improve [status|reset]", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "Prompt Improver settings require interactive TUI mode",
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Prompt Improver settings require Pi to be idle",
          "warning",
        );
        return;
      }
      const loaded = await store.load();
      if (!loaded.ok) {
        ctx.ui.notify(
          `Prompt Improver settings are invalid: ${redactError(loaded.error)}. Use /prompt-improve reset to recover.`,
          "error",
        );
        return;
      }
      try {
        await showSettings(ctx, store, runtime, loaded.settings, (settings) =>
          warnHighContext(ctx, settings),
        );
      } catch (error) {
        ctx.ui.notify(
          `Prompt Improver settings failed: ${redactError(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", () => {
    sessionEpoch += 1;
  });

  pi.on("session_start", (_event, ctx) => {
    const epoch = ++sessionEpoch;
    const activeModel = ctx.model;
    const runtime = new ImproverModelRuntime(
      ctx.modelRegistry,
      () => activeModel,
    );
    void warnForConfiguration(ctx, runtime, activeModel, epoch).catch(
      (error: unknown) => {
        if (epoch !== sessionEpoch) return;
        try {
          warnOnce(
            ctx,
            "startup-diagnostics",
            `Prompt Improver startup check failed: ${redactError(error)}`,
          );
        } catch {
          // The session context may have expired between the async check and notification.
        }
      },
    );
  });

  async function warnForConfiguration(
    ctx: ExtensionContext,
    runtime: ImproverModelRuntime,
    activeModel: ExtensionContext["model"],
    epoch: number,
  ): Promise<void> {
    const loaded = await store.load();
    if (epoch !== sessionEpoch) return;
    if (!loaded.ok) {
      warnOnce(
        ctx,
        "malformed-settings",
        `Prompt Improver disabled: ${redactError(loaded.error)}. Use /prompt-improve status or reset.`,
      );
      return;
    }
    warnHighContext(ctx, loaded.settings);
    const hasResolvableModel =
      loaded.settings.model.mode === "fixed" ||
      (loaded.settings.model.mode === "active" && activeModel !== undefined);
    if (!hasResolvableModel) return;
    const inspected = await runtime.inspect(loaded.settings);
    if (epoch !== sessionEpoch) return;
    if (inspected.configurationErrors.length > 0) {
      const key =
        loaded.settings.model.mode === "fixed" ? "fixed-model" : "active-model";
      warnOnce(
        ctx,
        key,
        `Prompt Improver disabled: ${inspected.configurationErrors[0]}`,
      );
    }
  }
}
