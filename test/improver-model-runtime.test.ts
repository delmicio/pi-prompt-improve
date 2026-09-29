import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_FAST_MODE_ERROR,
  CURSOR_SDK_ISOLATION_ERROR,
  hasMatchingLegacyStreamSimpleOverlay,
  ImproverModelRuntime,
  modelDefaultLegacyOverlayError,
  reconcileModelChange,
  resolveModelDefaultDispatch,
  supportsCodexFastMode,
} from "../src/improver-model-runtime.js";
import { defaultSettings } from "../src/settings-store.js";

const baseModel = {
  id: "m",
  name: "m",
  provider: "p",
  api: "test-api" as Api,
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100,
  maxTokens: 10,
} satisfies Model<Api>;

const codexModel = {
  ...baseModel,
  provider: "openai-codex",
  api: "openai-codex-responses" as Api,
};

const cursorModel = {
  ...baseModel,
  provider: "cursor",
  api: "cursor-sdk" as Api,
};

function assistantResponse(
  model: Pick<Model<Api>, "provider" | "id" | "api">,
  text = "improved",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function completionInput(thinking?: "off" | "high", fastMode = false) {
  return {
    systemInstruction: "only this",
    messages: [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "context" }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "draft" }],
      },
    ],
    signal: new AbortController().signal,
    ...(thinking ? { thinking } : {}),
    ...(fastMode ? { fastMode: true as const } : {}),
  };
}

function createRegistry(options: {
  model?: Model<Api>;
  provider?: Provider;
  complete?: (
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>,
  ) => Promise<AssistantMessage>;
  getApiKeyAndHeaders?: RegistryLike["getApiKeyAndHeaders"];
  getRegisteredNativeProvider?: RegistryLike["getRegisteredNativeProvider"];
  getRegisteredProviderConfig?: RegistryLike["getRegisteredProviderConfig"];
}) {
  const model = options.model ?? baseModel;
  const complete =
    options.complete ?? vi.fn(async () => assistantResponse(model));
  const nativeStream = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    stream.end(assistantResponse(model));
    return stream;
  });
  const streamSimple = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    stream.end(assistantResponse(model));
    return stream;
  });
  const provider =
    options.provider ??
    ({
      id: model.provider,
      name: model.provider,
      auth: {},
      getModels: () => [model],
      stream: vi.fn(),
      streamSimple,
    } satisfies Provider);
  const nativeProvider: Provider = {
    id: model.provider,
    name: model.provider,
    auth: {},
    getModels: () => [model],
    stream: nativeStream,
    streamSimple: vi.fn(),
  };

  const registry: RegistryLike = {
    find: vi.fn((providerId: string, modelId: string) =>
      providerId === model.provider && modelId === model.id ? model : undefined,
    ),
    getAvailable: vi.fn(() => [model]),
    getApiKeyAndHeaders:
      options.getApiKeyAndHeaders ??
      (async () => ({ ok: true as const, apiKey: "secret" })),
    complete,
    getProvider: vi.fn((providerId: string) =>
      providerId === model.provider ? provider : undefined,
    ),
    getRegisteredNativeProvider:
      options.getRegisteredNativeProvider ?? vi.fn(() => undefined),
    getRegisteredProviderConfig:
      options.getRegisteredProviderConfig ?? vi.fn(() => undefined),
  };

  return {
    registry,
    model,
    complete,
    provider,
    nativeStream,
    streamSimple,
    nativeProvider,
  };
}

type RegistryLike = ConstructorParameters<typeof ImproverModelRuntime>[0];

describe("ImproverModelRuntime", () => {
  it("detects matching legacy streamSimple overlays by configured api", () => {
    expect(
      hasMatchingLegacyStreamSimpleOverlay(
        { api: "test-api", streamSimple: vi.fn() },
        "test-api",
      ),
    ).toBe(true);
    expect(
      hasMatchingLegacyStreamSimpleOverlay(
        { api: "other-api", streamSimple: vi.fn() },
        "test-api",
      ),
    ).toBe(false);
    expect(
      hasMatchingLegacyStreamSimpleOverlay(
        { streamSimple: vi.fn() },
        "test-api",
      ),
    ).toBe(false);
    expect(
      hasMatchingLegacyStreamSimpleOverlay({ api: "test-api" }, "test-api"),
    ).toBe(false);
    expect(
      hasMatchingLegacyStreamSimpleOverlay(
        { api: "test-api", headers: { "x-test": "1" } },
        "test-api",
      ),
    ).toBe(false);
  });

  it("resolves model-default dispatch from Pi registry semantics", () => {
    const native = { id: "p" } as Provider;
    expect(
      resolveModelDefaultDispatch(
        {
          getRegisteredNativeProvider: () => native,
          getRegisteredProviderConfig: () => ({
            api: "test-api",
            streamSimple: vi.fn(),
          }),
        },
        "p",
        "test-api",
      ),
    ).toBe("native-extension");
    expect(
      resolveModelDefaultDispatch(
        {
          getRegisteredNativeProvider: () => undefined,
          getRegisteredProviderConfig: () => ({
            api: "test-api",
            streamSimple: vi.fn(),
          }),
        },
        "p",
        "test-api",
      ),
    ).toBe("legacy-overlay-blocked");
    expect(
      resolveModelDefaultDispatch(
        {
          getRegisteredNativeProvider: () => undefined,
          getRegisteredProviderConfig: () => ({
            headers: { authorization: "x" },
          }),
        },
        "p",
        "test-api",
      ),
    ).toBe("builtin-complete");
  });
  it("supports Fast mode only for the Codex Responses API", () => {
    expect(
      supportsCodexFastMode({
        provider: "openai-codex",
        api: "openai-codex-responses",
      } as never),
    ).toBe(true);
    expect(
      supportsCodexFastMode({
        provider: "openai-codex",
        api: "openai-responses",
      } as never),
    ).toBe(false);
  });

  it("resolves active model at each invocation without refreshing the registry", async () => {
    let active = { ...baseModel, provider: "a", id: "one" };
    const refresh = vi.fn(() => {
      throw new Error("Prompt Improver must not refresh Pi's registry");
    });
    const runtime = new ImproverModelRuntime(
      {
        refresh,
        find: vi.fn(),
        getAvailable: vi.fn(() => []),
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
        getProvider: vi.fn(),
        getRegisteredNativeProvider: vi.fn(),
        getRegisteredProviderConfig: vi.fn(),
      } as never,
      () => active as never,
      () => ["off", "high"],
    );

    expect((await runtime.inspect(defaultSettings())).identity).toBe("a/one");
    active = { ...baseModel, provider: "b", id: "two" };
    expect((await runtime.inspect(defaultSettings())).identity).toBe("b/two");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses native raw stream for native extension model default and composed simple stream for explicit levels", async () => {
    const { registry, complete, nativeStream, streamSimple, nativeProvider } =
      createRegistry({
        getRegisteredNativeProvider: vi.fn(() => nativeProvider),
      });
    const runtime = new ImproverModelRuntime(
      registry,
      () => baseModel as never,
      () => ["off", "high"],
    );

    const defaultPrepared = await runtime.prepare(defaultSettings());
    expect(defaultPrepared.ok).toBe(true);
    if (defaultPrepared.ok) {
      await defaultPrepared.invocation.complete(completionInput());
    }

    const offPrepared = await runtime.prepare({
      ...defaultSettings(),
      thinking: "off",
    });
    expect(offPrepared.ok).toBe(true);
    if (offPrepared.ok) {
      await offPrepared.invocation.complete(completionInput("off"));
    }

    const highPrepared = await runtime.prepare({
      ...defaultSettings(),
      thinking: "high",
    });
    expect(highPrepared.ok).toBe(true);
    if (highPrepared.ok) {
      await highPrepared.invocation.complete(completionInput("high"));
    }

    expect(nativeStream).toHaveBeenCalledTimes(1);
    for (const stream of [nativeStream, streamSimple]) {
      const calls = stream.mock.calls as unknown as Array<
        [unknown, Parameters<Provider["stream"]>[1]]
      >;
      for (const [, context] of calls) {
        expect(context.messages[0]?.role).toBe("system");
        expect(getCurrentSystemPrompt(context.messages)).toBe("only this");
        expect(context).not.toHaveProperty("systemPrompt");
        expect(
          context.messages.slice(1).map((message) => message.role),
        ).toEqual(["assistant", "user"]);
      }
    }
    expect(complete).not.toHaveBeenCalled();
    expect(streamSimple).toHaveBeenCalledTimes(2);
    const simpleCalls = streamSimple.mock.calls as unknown as Array<
      [unknown, unknown, Record<string, unknown>]
    >;
    expect(simpleCalls[0]?.[2]).not.toHaveProperty("reasoning");
    expect(simpleCalls[1]?.[2]).toMatchObject({ reasoning: "high" });
  });

  it("uses registry.complete for built-in model default without native extension or legacy overlay", async () => {
    const { registry, complete, nativeStream } = createRegistry({});
    const runtime = new ImproverModelRuntime(
      registry,
      () => baseModel as never,
      () => ["off", "high"],
    );

    const inspected = await runtime.inspect(defaultSettings());
    expect(inspected.configurationErrors).toEqual([]);

    const prepared = await runtime.prepare(defaultSettings());
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      await prepared.invocation.complete(completionInput());
    }
    expect(complete).toHaveBeenCalledOnce();
    expect(nativeStream).not.toHaveBeenCalled();
  });

  it("fails closed for model default when a matching legacy streamSimple overlay is registered", async () => {
    const { registry, complete } = createRegistry({
      getRegisteredProviderConfig: vi.fn(() => ({
        api: "test-api",
        streamSimple: vi.fn(),
      })),
    });
    const runtime = new ImproverModelRuntime(
      registry,
      () => baseModel as never,
      () => ["off", "high"],
    );

    const inspected = await runtime.inspect(defaultSettings());
    expect(inspected.configurationErrors).toEqual([
      modelDefaultLegacyOverlayError("p"),
    ]);

    const prepared = await runtime.prepare(defaultSettings());
    expect(prepared).toMatchObject({
      ok: false,
      error: modelDefaultLegacyOverlayError("p"),
      identity: "p/m",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("allows model default when legacy config has no matching streamSimple overlay", async () => {
    for (const config of [
      undefined,
      { headers: { authorization: "Bearer token" } },
      { api: "other-api", streamSimple: vi.fn() },
      { streamSimple: vi.fn() },
    ]) {
      const { registry, complete } = createRegistry({
        getRegisteredProviderConfig: vi.fn(() => config),
      });
      const runtime = new ImproverModelRuntime(
        registry,
        () => baseModel as never,
        () => ["off", "high"],
      );

      const prepared = await runtime.prepare(defaultSettings());
      expect(prepared.ok).toBe(true);
      if (prepared.ok) {
        await prepared.invocation.complete(completionInput());
      }
      expect(complete).toHaveBeenCalledOnce();
    }
  });

  it("allows explicit thinking when a legacy overlay blocks model default", async () => {
    const { registry, complete, streamSimple } = createRegistry({
      getRegisteredProviderConfig: vi.fn(() => ({
        api: "test-api",
        streamSimple: vi.fn(),
      })),
    });
    const runtime = new ImproverModelRuntime(
      registry,
      () => baseModel as never,
      () => ["off", "high"],
    );
    const prepared = await runtime.prepare({
      ...defaultSettings(),
      thinking: "high",
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      await prepared.invocation.complete(completionInput("high"));
    }
    expect(streamSimple).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("forwards Fast mode and explicit thinking through registry.complete without pre-auth", async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: "secret",
    }));
    const { registry, complete } = createRegistry({
      model: codexModel,
      getApiKeyAndHeaders,
    });
    const runtime = new ImproverModelRuntime(
      registry,
      () => codexModel as never,
    );

    const highPrepared = await runtime.prepare({
      ...defaultSettings(),
      fastMode: true,
      thinking: "high",
    });
    expect(highPrepared.ok).toBe(true);
    if (highPrepared.ok) {
      await highPrepared.invocation.complete(completionInput("high", true));
    }

    const offPrepared = await runtime.prepare({
      ...defaultSettings(),
      fastMode: true,
      thinking: "off",
    });
    expect(offPrepared.ok).toBe(true);
    if (offPrepared.ok) {
      await offPrepared.invocation.complete(completionInput("off", true));
    }

    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const rawCalls = (complete as ReturnType<typeof vi.fn>).mock.calls as Array<
      [unknown, unknown, Record<string, unknown>]
    >;
    expect(rawCalls[0]?.[2]).toMatchObject({
      serviceTier: "priority",
      reasoningEffort: "high",
    });
    expect(rawCalls[1]?.[2]).toMatchObject({
      serviceTier: "priority",
      reasoningEffort: "none",
    });
  });

  it("fails closed for cursor-sdk models before invocation", async () => {
    const runtime = new ImproverModelRuntime(
      {
        find: vi.fn(() => cursorModel),
        getAvailable: vi.fn(() => [cursorModel]),
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
        getProvider: vi.fn(),
        getRegisteredNativeProvider: vi.fn(),
        getRegisteredProviderConfig: vi.fn(),
      },
      () => cursorModel as never,
      () => ["off", "high"],
    );
    const prepared = await runtime.prepare({
      ...defaultSettings(),
      model: { mode: "fixed", provider: "cursor", model: "m" },
      thinking: "high",
    });
    expect(prepared).toMatchObject({
      ok: false,
      error: CURSOR_SDK_ISOLATION_ERROR,
      identity: "cursor/m",
    });
  });

  it("accepts registry-resolved header-only and keyless authentication", async () => {
    for (const auth of [
      { ok: true as const, headers: { authorization: "Bearer resolved" } },
      { ok: true as const },
    ]) {
      const nativeStream = vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        stream.end(assistantResponse(baseModel));
        return stream;
      });
      const runtime = new ImproverModelRuntime(
        {
          find: vi.fn(() => baseModel),
          getAvailable: vi.fn(() => [baseModel]),
          getApiKeyAndHeaders: async () => auth,
          complete: vi.fn(),
          getProvider: vi.fn(),
          getRegisteredNativeProvider: vi.fn(() => ({
            id: "p",
            name: "p",
            auth: {},
            getModels: () => [baseModel],
            stream: nativeStream,
            streamSimple: vi.fn(),
          })),
          getRegisteredProviderConfig: vi.fn(),
        },
        () => baseModel as never,
      );
      const prepared = await runtime.prepare(defaultSettings());
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      await prepared.invocation.complete(completionInput());
      expect(nativeStream).toHaveBeenCalledOnce();
      const options = (
        nativeStream.mock.calls as unknown as Array<
          [unknown, unknown, Record<string, unknown>]
        >
      )[0]?.[2];
      if ("headers" in auth) {
        expect(options).toMatchObject({ headers: auth.headers });
      } else {
        expect(options).not.toHaveProperty("apiKey");
      }
    }
  });

  it("does not start provider work when cancellation wins during authentication", async () => {
    const controller = new AbortController();
    const getApiKeyAndHeaders = vi.fn(() => new Promise<never>(() => {}));
    const streamSimple = vi.fn();
    const runtime = new ImproverModelRuntime(
      {
        find: vi.fn(() => baseModel),
        getAvailable: vi.fn(() => [baseModel]),
        getApiKeyAndHeaders,
        complete: vi.fn(),
        getProvider: vi.fn(() => ({
          id: "p",
          name: "p",
          auth: {},
          getModels: () => [baseModel],
          stream: vi.fn(),
          streamSimple,
        })),
        getRegisteredNativeProvider: vi.fn(() => undefined),
        getRegisteredProviderConfig: vi.fn(),
      },
      () => baseModel as never,
      () => ["off", "high"],
    );
    const prepared = await runtime.prepare({
      ...defaultSettings(),
      thinking: "high",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const completion = prepared.invocation.complete({
      ...completionInput(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("does not start a provider when abort follows authentication resolution", async () => {
    for (const thinking of ["default", "high"] as const) {
      const controller = new AbortController();
      const { registry, nativeStream, nativeProvider, streamSimple } =
        createRegistry({
          getRegisteredNativeProvider: () => nativeProvider,
          getApiKeyAndHeaders: () => {
            queueMicrotask(() => queueMicrotask(() => controller.abort()));
            return Promise.resolve({ ok: true as const });
          },
        });
      const runtime = new ImproverModelRuntime(
        registry,
        () => baseModel,
        () => ["off", "high"],
      );
      const prepared = await runtime.prepare({
        ...defaultSettings(),
        thinking,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      await expect(
        prepared.invocation.complete({
          ...completionInput(),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(nativeStream).not.toHaveBeenCalled();
      expect(streamSimple).not.toHaveBeenCalled();
    }
  });

  it("does not expose request text from thrown provider errors", async () => {
    const { registry } = createRegistry({
      complete: async () => {
        throw new Error("request rejected: private draft and private guidance");
      },
    });
    const runtime = new ImproverModelRuntime(registry, () => baseModel);
    const prepared = await runtime.prepare(defaultSettings());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await expect(
      prepared.invocation.complete(completionInput()),
    ).rejects.toThrow(
      "Provider request failed for p/m. Check provider status and authentication.",
    );
  });

  it("classifies context overflow from provider errors", async () => {
    const overflowResponse: AssistantMessage = {
      ...assistantResponse(baseModel),
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    };
    const { registry, nativeStream, nativeProvider } = createRegistry({
      getRegisteredNativeProvider: vi.fn(() => nativeProvider),
    });
    nativeStream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      stream.end(overflowResponse);
      return stream;
    });
    const runtime = new ImproverModelRuntime(
      registry,
      () => baseModel as never,
    );
    const prepared = await runtime.prepare(defaultSettings());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await prepared.invocation.complete(completionInput());
    expect(result.overflow).toBe(true);
  });

  it("fails closed before invocation for unsupported thinking and Fast mode", async () => {
    const runtime = new ImproverModelRuntime(
      createRegistry({}).registry,
      () => baseModel as never,
      () => ["off"],
    );

    const thinking = await runtime.prepare({
      ...defaultSettings(),
      thinking: "max",
    });
    expect(thinking).toMatchObject({
      ok: false,
      error: "Thinking level max is not supported by p/m",
    });

    const fast = await runtime.prepare({
      ...defaultSettings(),
      fastMode: true,
    });
    expect(fast).toMatchObject({ ok: false, error: CODEX_FAST_MODE_ERROR });
  });

  it("plans compatible model changes without confirmation", () => {
    const runtime = new ImproverModelRuntime(
      createRegistry({ model: codexModel }).registry,
      () => codexModel as never,
      () => ["off", "high"],
    );
    const settings = {
      ...defaultSettings(),
      thinking: "high" as const,
      fastMode: true,
      model: { mode: "fixed" as const, provider: "openai-codex", model: "m" },
    };

    const plan = runtime.planModelChange(settings, {
      mode: "fixed",
      provider: "openai-codex",
      model: "m",
    });
    expect(plan).toEqual({
      kind: "ready",
      proposedSettings: settings,
    });
  });

  it("requires one confirmation when thinking and Fast mode become invalid", () => {
    const highThinkingModel = {
      ...baseModel,
      provider: "codex",
      id: "gpt",
      api: "openai-codex-responses" as Api,
    };
    const plainModel = {
      ...baseModel,
      provider: "plain",
      id: "basic",
      reasoning: false,
    };
    const runtime = new ImproverModelRuntime(
      {
        find: vi.fn((provider: string, id: string) => {
          if (provider === "codex" && id === "gpt") return highThinkingModel;
          if (provider === "plain" && id === "basic") return plainModel;
          return undefined;
        }),
        getAvailable: vi.fn(() => [highThinkingModel, plainModel]),
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
        getProvider: vi.fn(),
        getRegisteredNativeProvider: vi.fn(),
        getRegisteredProviderConfig: vi.fn(),
      },
      () => highThinkingModel as never,
      (model) => (model.provider === "codex" ? (["off", "high"] as const) : []),
    );

    const current = {
      ...defaultSettings(),
      model: { mode: "fixed" as const, provider: "codex", model: "gpt" },
      thinking: "high" as const,
      fastMode: true,
    };
    const plan = runtime.planModelChange(current, {
      mode: "fixed",
      provider: "plain",
      model: "basic",
    });

    expect(plan.kind).toBe("confirmation-required");
    if (plan.kind !== "confirmation-required") return;
    expect(plan.dependentChanges).toEqual([
      { field: "thinking", from: "high", to: "Model default" },
      { field: "fastMode", from: "on", to: "off" },
    ]);
    expect(plan.confirmationSummary).toContain("thinking");
    expect(plan.confirmationSummary).toContain("fastMode");
    expect(plan.proposedSettings).toMatchObject({
      model: { mode: "fixed", provider: "plain", model: "basic" },
      thinking: "default",
      fastMode: false,
    });
  });

  it("inspect reports stale settings without repairing them", async () => {
    const runtime = new ImproverModelRuntime(
      createRegistry({}).registry,
      () => baseModel as never,
      () => ["off"],
    );
    const inspected = await runtime.inspect({
      ...defaultSettings(),
      thinking: "high",
      fastMode: true,
    });
    expect(inspected.configurationErrors).toEqual([
      "Thinking level high is not supported by p/m",
      CODEX_FAST_MODE_ERROR,
    ]);
  });

  it("reconcileModelChange is pure from settings and target capabilities", () => {
    const settings = {
      ...defaultSettings(),
      model: { mode: "fixed" as const, provider: "codex", model: "gpt" },
      thinking: "high" as const,
      fastMode: true,
    };
    const plan = reconcileModelChange(
      settings,
      { mode: "fixed", provider: "plain", model: "basic" },
      { supportedThinking: ["off"], fastModeSupported: false },
    );
    expect(plan.kind).toBe("confirmation-required");
    if (plan.kind !== "confirmation-required") return;
    expect(plan.proposedSettings).toMatchObject({
      model: { mode: "fixed", provider: "plain", model: "basic" },
      thinking: "default",
      fastMode: false,
    });
    expect(settings.thinking).toBe("high");
    expect(settings.fastMode).toBe(true);
  });
});
