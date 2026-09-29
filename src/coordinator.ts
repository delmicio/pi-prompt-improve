import { collectContextMessages, type ContextMessage } from "./context.js";
import { type PreparedImproverInvocation } from "./improver-model-runtime.js";
import { normalizeModelOutput } from "./output.js";
import { buildPromptProtocol } from "./prompt-protocol.js";
import { redactError } from "./redact.js";
import type {
  PromptImproveSettings,
  SettingsLoadResult,
} from "./settings-store.js";

export interface CoordinatorDeps {
  runtime: {
    mode(): "tui" | "rpc" | "json" | "print";
    isIdle(): boolean;
    getDraft(): string;
    setDraft(text: string): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
    getActiveContextEntries(): readonly unknown[];
  };
  settings: { load(): Promise<SettingsLoadResult> };
  improverModel: {
    prepare(
      settings: PromptImproveSettings,
    ): Promise<
      | { ok: true; invocation: PreparedImproverInvocation }
      | { ok: false; error: string; identity?: string }
    >;
  };
  ui: {
    beginSetup(metadata: { mainRunContinues?: boolean }): {
      signal: AbortSignal;
      dispose(): void;
    };
    runWithLoader<T>(
      metadata: {
        identity: string;
        context: "off" | number;
        mainRunContinues?: boolean;
      },
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<
      | { kind: "success"; value: T }
      | { kind: "cancelled" }
      | { kind: "error"; error: unknown }
    >;
    preview(input: {
      identity: string;
      thinking: PromptImproveSettings["thinking"];
      original: string;
      improved: string;
      mainRunContinues?: boolean;
    }): Promise<"replace" | "keep" | "retry">;
  };
}

export class OperationCoordinator {
  private running = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  async run(): Promise<void> {
    if (this.running) {
      this.deps.runtime.notify(
        "Prompt improvement already in progress",
        "warning",
      );
      return;
    }
    if (this.deps.runtime.mode() !== "tui") {
      this.deps.runtime.notify(
        "Prompt Improver requires interactive TUI mode",
        "error",
      );
      return;
    }
    const mainRunContinues = !this.deps.runtime.isIdle();
    const original = this.deps.runtime.getDraft();
    if (original.trim().length === 0) {
      this.deps.runtime.notify("Enter a draft before improving it", "warning");
      return;
    }

    const invocationContext = collectContextMessages([
      ...this.deps.runtime.getActiveContextEntries(),
    ]);

    this.running = true;
    let setup: ReturnType<CoordinatorDeps["ui"]["beginSetup"]> | undefined;
    let identity = "configured model";
    let preparedInvocation: PreparedImproverInvocation | undefined;
    try {
      setup = this.deps.ui.beginSetup({ mainRunContinues });
      const loaded = await raceWithAbort(setup.signal, () =>
        this.deps.settings.load(),
      );
      if (setup.signal.aborted) {
        this.deps.runtime.notify("Improvement cancelled", "info");
        return;
      }
      if (!loaded.ok) throw new Error(loaded.error);
      const settings = loaded.settings;
      const prepared = await raceWithAbort(setup.signal, () =>
        this.deps.improverModel.prepare(settings),
      );
      if (setup.signal.aborted) {
        this.deps.runtime.notify("Improvement cancelled", "info");
        return;
      }
      if (!prepared.ok) {
        identity = prepared.identity ?? identity;
        throw new Error(prepared.error);
      }
      preparedInvocation = prepared.invocation;
      identity = prepared.invocation.identity;
      const context = settings.context.enabled
        ? invocationContext.slice(-settings.context.count)
        : [];
      const protocol = buildPromptProtocol(
        settings.instruction,
        context,
        original,
      );
      setup.dispose();
      while (true) {
        const loader = await this.deps.ui.runWithLoader(
          {
            identity,
            context: settings.context.enabled ? context.length : "off",
            mainRunContinues,
          },
          async (signal) =>
            preparedInvocation!.complete({
              systemInstruction: protocol.systemInstruction,
              messages: protocol.messages,
              signal,
            }),
        );
        if (loader.kind === "cancelled") {
          this.deps.runtime.notify("Improvement cancelled", "info");
          return;
        }
        if (loader.kind === "error") throw loader.error;
        if (loader.value.overflow) {
          throw new Error(`Request exceeds ${identity} context window`);
        }
        const improved = normalizeModelOutput(loader.value.content);
        const decision = await this.deps.ui.preview({
          identity,
          thinking: settings.thinking,
          original,
          improved,
          mainRunContinues,
        });
        if (decision === "retry") continue;
        if (decision === "keep") {
          this.deps.runtime.notify("Original prompt kept", "info");
          return;
        }
        if (this.deps.runtime.getDraft() !== original) {
          this.deps.runtime.notify(
            "Draft changed while Prompt Improver was running. Current draft was preserved. Run Prompt Improver again to improve the latest text.",
            "warning",
          );
          return;
        }
        this.deps.runtime.setDraft(improved);
        this.deps.runtime.notify("Prompt replaced", "info");
        return;
      }
    } catch (error) {
      if (setup?.signal.aborted) {
        this.deps.runtime.notify("Improvement cancelled", "info");
        return;
      }
      const detail = redactError(error);
      this.deps.runtime.notify(
        `Prompt improvement failed for ${identity}: ${detail}`,
        "error",
      );
    } finally {
      try {
        setup?.dispose();
      } finally {
        this.running = false;
      }
    }
  }
}

function raceWithAbort<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Improvement cancelled", "AbortError"),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason ??
          new DOMException("Improvement cancelled", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = task();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
