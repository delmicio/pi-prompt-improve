import {
  getSupportedThinkingLevels,
  isContextOverflow,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Provider,
  type ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "./context.js";
import type {
  PromptImproveSettings,
  ThinkingLevel,
  ThinkingSetting,
} from "./settings-store.js";

export const CODEX_FAST_MODE_ERROR =
  "Fast mode is only supported for openai-codex Codex Responses models";

export const CURSOR_SDK_ISOLATION_ERROR =
  "Cursor SDK models cannot be used for isolated prompt improvement because they share Pi's active session. Choose a different improver model.";

export function modelDefaultLegacyOverlayError(provider: string): string {
  return `Model-default thinking for ${provider} is blocked because a legacy streamSimple overlay is registered for this provider's API. The overlay can change default-thinking semantics. Select an explicit thinking level instead.`;
}

interface LegacyProviderConfig {
  api?: Api;
  streamSimple?: unknown;
  headers?: Record<string, string>;
}

export function hasMatchingLegacyStreamSimpleOverlay(
  config: LegacyProviderConfig | undefined,
  modelApi: Api,
): boolean {
  if (!config?.streamSimple) return false;
  if (config.api === undefined) return false;
  return config.api === modelApi;
}

export type ModelDefaultDispatch =
  "native-extension" | "legacy-overlay-blocked" | "builtin-complete";

export function resolveModelDefaultDispatch(
  registry: {
    getRegisteredNativeProvider(provider: string): Provider | undefined;
    getRegisteredProviderConfig(
      provider: string,
    ): LegacyProviderConfig | undefined;
  },
  provider: string,
  modelApi: Api,
): ModelDefaultDispatch {
  if (registry.getRegisteredNativeProvider(provider)) {
    return "native-extension";
  }
  if (
    hasMatchingLegacyStreamSimpleOverlay(
      registry.getRegisteredProviderConfig(provider),
      modelApi,
    )
  ) {
    return "legacy-overlay-blocked";
  }
  return "builtin-complete";
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type ModelSelection =
  { mode: "active" } | { mode: "fixed"; provider: string; model: string };

export interface TargetModelCapabilities {
  supportedThinking: readonly ThinkingLevel[];
  fastModeSupported: boolean;
}

export interface InspectResult {
  identity: string;
  supportedThinking: readonly ThinkingLevel[];
  fastModeSupported: boolean;
  configurationErrors: string[];
}

export interface DependentSettingChange {
  field: "thinking" | "fastMode";
  from: string;
  to: string;
}

export type ModelChangePlan =
  | {
      kind: "ready";
      proposedSettings: PromptImproveSettings;
    }
  | {
      kind: "confirmation-required";
      proposedSettings: PromptImproveSettings;
      dependentChanges: DependentSettingChange[];
      confirmationSummary: string;
    }
  | {
      kind: "invalid";
      error: string;
    };

export interface PreparedImproverInvocation {
  identity: string;
  thinkingLabel: string;
  fastModeRequested: boolean;
  complete(input: {
    systemInstruction: string;
    messages: ContextMessage[];
    signal: AbortSignal;
  }): Promise<{ content: readonly unknown[]; overflow: boolean }>;
}

export type PrepareResult =
  | { ok: true; invocation: PreparedImproverInvocation }
  | { ok: false; error: string; identity?: string };

interface RegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAvailable(): Model<Api>[];
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): ReturnType<ModelRegistry["getApiKeyAndHeaders"]>;
  complete(
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>,
  ): Promise<AssistantMessage>;
  getProvider(provider: string): Provider | undefined;
  getRegisteredNativeProvider(provider: string): Provider | undefined;
  getRegisteredProviderConfig(
    provider: string,
  ): LegacyProviderConfig | undefined;
}

interface ResolvedModel {
  identity: string;
  model: Model<Api>;
  supportedThinking: readonly ThinkingLevel[];
  fastModeSupported: boolean;
}

export function supportsCodexFastMode(
  model: Pick<Model<Api>, "provider" | "api">,
): boolean {
  return (
    model.provider === "openai-codex" && model.api === "openai-codex-responses"
  );
}

export function requiresSessionCoupledApi(
  model: Pick<Model<Api>, "api">,
): boolean {
  return model.api === "cursor-sdk";
}

export function reconcileModelChange(
  settings: PromptImproveSettings,
  target: ModelSelection,
  capabilities: TargetModelCapabilities,
): ModelChangePlan {
  const proposed: PromptImproveSettings = {
    ...settings,
    model:
      target.mode === "active"
        ? { mode: "active" }
        : {
            mode: "fixed",
            provider: target.provider,
            model: target.model,
          },
  };

  const dependentChanges: DependentSettingChange[] = [];

  if (
    proposed.thinking !== "default" &&
    !capabilities.supportedThinking.includes(proposed.thinking)
  ) {
    dependentChanges.push({
      field: "thinking",
      from: proposed.thinking,
      to: "Model default",
    });
    proposed.thinking = "default";
  }

  if (proposed.fastMode && !capabilities.fastModeSupported) {
    dependentChanges.push({
      field: "fastMode",
      from: "on",
      to: "off",
    });
    proposed.fastMode = false;
  }

  if (dependentChanges.length === 0) {
    return { kind: "ready", proposedSettings: proposed };
  }

  const lines = dependentChanges.map(
    (change) => `${change.field}: ${change.from} → ${change.to}`,
  );
  return {
    kind: "confirmation-required",
    proposedSettings: proposed,
    dependentChanges,
    confirmationSummary: [
      "Changing the improver model requires updating dependent settings:",
      ...lines.map((line) => `- ${line}`),
    ].join("\n"),
  };
}

export class ImproverModelRuntime {
  constructor(
    private readonly registry: RegistryLike,
    private readonly activeModel: () => Model<Api> | undefined,
    private readonly supportedLevels: (model: Model<Api>) => ThinkingLevel[] = (
      model,
    ) => getSupportedThinkingLevels(model) as ThinkingLevel[],
  ) {}

  async available(): Promise<Model<Api>[]> {
    return this.registry.getAvailable();
  }

  async inspect(settings: PromptImproveSettings): Promise<InspectResult> {
    const resolved = await this.resolve(settings);
    if (!resolved.ok) {
      return {
        identity: resolved.identity ?? "invalid",
        supportedThinking: [],
        fastModeSupported: false,
        configurationErrors: [resolved.error],
      };
    }
    const configurationErrors = this.configurationErrors(
      settings,
      resolved.model,
    );
    return {
      identity: resolved.model.identity,
      supportedThinking: resolved.model.supportedThinking,
      fastModeSupported: resolved.model.fastModeSupported,
      configurationErrors,
    };
  }

  planModelChange(
    settings: PromptImproveSettings,
    target: ModelSelection,
  ): ModelChangePlan {
    const targetModel = this.resolveTargetModel(target);
    if (!targetModel.ok) {
      return { kind: "invalid", error: targetModel.error };
    }

    return reconcileModelChange(settings, target, {
      supportedThinking: targetModel.model.supportedThinking,
      fastModeSupported: targetModel.model.fastModeSupported,
    });
  }

  async prepare(settings: PromptImproveSettings): Promise<PrepareResult> {
    const resolved = await this.resolve(settings);
    if (!resolved.ok) {
      return {
        ok: false,
        error: resolved.error,
        ...(resolved.identity ? { identity: resolved.identity } : {}),
      };
    }

    const errors = this.configurationErrors(settings, resolved.model);
    if (errors.length > 0) {
      return {
        ok: false,
        error: errors[0]!,
        identity: resolved.model.identity,
      };
    }

    const thinking =
      settings.thinking === "default" ? undefined : settings.thinking;
    const fastMode = settings.fastMode;
    const identity = resolved.model.identity;
    const model = resolved.model.model;

    return {
      ok: true,
      invocation: {
        identity,
        thinkingLabel:
          settings.thinking === "default" ? "Model default" : settings.thinking,
        fastModeRequested: fastMode,
        complete: async ({ systemInstruction, messages, signal }) => {
          try {
            return await this.dispatchCompletion({
              model,
              identity,
              systemInstruction,
              messages,
              ...(thinking ? { thinking } : {}),
              fastMode,
              signal,
            });
          } catch (error) {
            if (signal.aborted) {
              throw new DOMException("Improvement cancelled", "AbortError");
            }
            if (error instanceof DOMException && error.name === "AbortError") {
              throw error;
            }
            // Providers and credential commands may echo request text in errors.
            // Never pass their payloads into notifications or logs.
            throw new Error(
              `Provider request failed for ${identity}. Check provider status and authentication.`,
            );
          }
        },
      },
    };
  }

  private configurationErrors(
    settings: PromptImproveSettings,
    resolved: ResolvedModel,
  ): string[] {
    const errors: string[] = [];
    if (requiresSessionCoupledApi(resolved.model)) {
      errors.push(CURSOR_SDK_ISOLATION_ERROR);
    }
    if (
      settings.thinking !== "default" &&
      !resolved.supportedThinking.includes(settings.thinking)
    ) {
      errors.push(
        `Thinking level ${settings.thinking} is not supported by ${resolved.identity}`,
      );
    }
    if (settings.fastMode && !resolved.fastModeSupported) {
      errors.push(CODEX_FAST_MODE_ERROR);
    }
    if (settings.thinking === "default") {
      const dispatch = resolveModelDefaultDispatch(
        this.registry,
        resolved.model.provider,
        resolved.model.api,
      );
      if (dispatch === "legacy-overlay-blocked") {
        errors.push(modelDefaultLegacyOverlayError(resolved.model.provider));
      }
    }
    return errors;
  }

  private resolveTargetModel(
    target: ModelSelection,
  ): { ok: true; model: ResolvedModel } | { ok: false; error: string } {
    if (target.mode === "active") {
      const model = this.activeModel();
      if (!model) {
        return { ok: false, error: "No active session model is selected" };
      }
      return { ok: true, model: this.wrap(model) };
    }

    const identity = `${target.provider}/${target.model}`;
    const model = this.registry.find(target.provider, target.model);
    const available = model
      ? this.registry
          .getAvailable()
          .some(
            (candidate) =>
              candidate.provider === model.provider &&
              candidate.id === model.id,
          )
      : false;
    if (!model || !available) {
      return {
        ok: false,
        error: `Fixed model ${identity} is missing or unavailable`,
      };
    }
    return { ok: true, model: this.wrap(model) };
  }

  private async resolve(
    settings: PromptImproveSettings,
  ): Promise<
    | { ok: true; model: ResolvedModel }
    | { ok: false; error: string; identity?: string }
  > {
    if (settings.model.mode === "active") {
      const model = this.activeModel();
      if (!model) {
        return { ok: false, error: "No active session model is selected" };
      }
      return { ok: true, model: this.wrap(model) };
    }

    const identity = `${settings.model.provider}/${settings.model.model}`;
    const model = this.registry.find(
      settings.model.provider,
      settings.model.model,
    );
    const available = model
      ? this.registry
          .getAvailable()
          .some(
            (candidate) =>
              candidate.provider === model.provider &&
              candidate.id === model.id,
          )
      : false;
    if (!model || !available) {
      return {
        ok: false,
        identity,
        error: `Fixed model ${identity} is missing or unavailable`,
      };
    }
    return { ok: true, model: this.wrap(model) };
  }

  private wrap(model: Model<Api>): ResolvedModel {
    return {
      identity: `${model.provider}/${model.id}`,
      model,
      supportedThinking: this.supportedLevels(model),
      fastModeSupported: supportsCodexFastMode(model),
    };
  }

  private async dispatchCompletion(input: {
    model: Model<Api>;
    identity: string;
    systemInstruction: string;
    messages: ContextMessage[];
    thinking?: ThinkingLevel;
    fastMode: boolean;
    signal: AbortSignal;
  }): Promise<{ content: readonly unknown[]; overflow: boolean }> {
    if (input.fastMode && !supportsCodexFastMode(input.model)) {
      throw new Error(CODEX_FAST_MODE_ERROR);
    }
    if (requiresSessionCoupledApi(input.model)) {
      throw new Error(CURSOR_SDK_ISOLATION_ERROR);
    }

    input.signal.throwIfAborted();
    const context = this.buildContext(
      input.model,
      input.systemInstruction,
      input.messages,
    );

    const response =
      input.thinking === undefined && !input.fastMode
        ? await this.completeModelDefault(input.model, context, input.signal)
        : input.fastMode
          ? await this.registry.complete(input.model, context, {
              signal: input.signal,
              serviceTier: "priority",
              ...(input.thinking
                ? {
                    reasoningEffort:
                      input.thinking === "off" ? "none" : input.thinking,
                  }
                : {}),
            })
          : await this.completeExplicitThinking(
              input.model,
              context,
              input.signal,
              input.thinking!,
            );

    if (response.stopReason === "aborted" || input.signal.aborted) {
      throw new DOMException("Improvement cancelled", "AbortError");
    }
    if (
      response.stopReason === "error" &&
      !isContextOverflow(response, input.model.contextWindow)
    ) {
      throw new Error(
        `Provider request failed for ${input.identity}. Check provider status and authentication.`,
      );
    }
    return {
      content: response.content,
      overflow: isContextOverflow(response, input.model.contextWindow),
    };
  }

  private async completeModelDefault(
    model: Model<Api>,
    context: Context,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const dispatch = resolveModelDefaultDispatch(
      this.registry,
      model.provider,
      model.api,
    );
    if (dispatch === "legacy-overlay-blocked") {
      throw new Error(modelDefaultLegacyOverlayError(model.provider));
    }
    if (dispatch === "builtin-complete") {
      return this.registry.complete(model, context, { signal });
    }

    const native = this.registry.getRegisteredNativeProvider(model.provider)!;
    const auth = await raceWithAbort(signal, () =>
      this.registry.getApiKeyAndHeaders(model),
    );
    if (!auth.ok) {
      throw new Error(
        `Authentication unavailable for ${model.provider}/${model.id}. Run /login for its provider.`,
      );
    }

    const requestModel =
      auth.baseUrl && auth.baseUrl !== model.baseUrl
        ? { ...model, baseUrl: auth.baseUrl }
        : model;
    const options = {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      signal,
    };
    signal.throwIfAborted();
    return native
      .stream(requestModel, normalizeContext(context), options)
      .result();
  }

  private async completeExplicitThinking(
    model: Model<Api>,
    context: Context,
    signal: AbortSignal,
    thinking: ThinkingLevel,
  ): Promise<AssistantMessage> {
    const auth = await raceWithAbort(signal, () =>
      this.registry.getApiKeyAndHeaders(model),
    );
    if (!auth.ok) {
      throw new Error(
        `Authentication unavailable for ${model.provider}/${model.id}. Run /login for its provider.`,
      );
    }

    const requestModel =
      auth.baseUrl && auth.baseUrl !== model.baseUrl
        ? { ...model, baseUrl: auth.baseUrl }
        : model;
    const options = {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      signal,
      ...(thinking === "off" ? {} : { reasoning: thinking as PiThinkingLevel }),
    };

    const provider = this.registry.getProvider(model.provider);
    if (!provider) {
      throw new Error(
        `Provider ${model.provider} is not registered for ${model.provider}/${model.id}`,
      );
    }
    signal.throwIfAborted();
    return provider
      .streamSimple(requestModel, normalizeContext(context), options)
      .result();
  }

  private buildContext(
    model: Model<Api>,
    systemInstruction: string,
    messages: ContextMessage[],
  ): Context {
    const now = Date.now();
    const converted: Message[] = messages.map((message): Message => {
      if (message.role === "user") {
        return { role: "user", content: message.content, timestamp: now };
      }
      return {
        role: "assistant",
        content: message.content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: now,
      };
    });
    return { systemPrompt: systemInstruction, messages: converted };
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
