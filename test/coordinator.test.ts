import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  OperationCoordinator,
  type CoordinatorDeps,
} from "../src/coordinator.js";
import { ImproverModelRuntime } from "../src/improver-model-runtime.js";
import type { PreparedImproverInvocation } from "../src/improver-model-runtime.js";
import { defaultSettings } from "../src/settings-store.js";

function completedSetup() {
  return {
    signal: new AbortController().signal,
    dispose: vi.fn(),
  };
}

function createInvocation(
  overrides: Partial<PreparedImproverInvocation> & {
    completeImpl?: PreparedImproverInvocation["complete"];
  } = {},
): PreparedImproverInvocation {
  const requests: unknown[] = [];
  const complete =
    overrides.completeImpl ??
    overrides.complete ??
    (async (input) => {
      requests.push(input);
      return {
        content: [
          { type: "text", text: "Make endpoint clearly.\r\n" },
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "Keep /tmp/x" },
        ],
        overflow: false,
      };
    });
  return {
    identity: "anthropic/sonnet",
    thinkingLabel: "Model default",
    fastModeRequested: false,
    complete,
    ...overrides,
  };
}

function harness(overrides: Partial<CoordinatorDeps> = {}) {
  let draft = "make endpoint\r\nkeep /tmp/x";
  const notices: Array<[string, string]> = [];
  const requests: unknown[] = [];
  const previews: unknown[] = [];
  const loaderMetadata: unknown[] = [];
  const setupMetadata: unknown[] = [];
  const invocation = createInvocation({
    completeImpl: async (input) => {
      requests.push(input);
      return {
        content: [
          { type: "text", text: "Make endpoint clearly.\r\n" },
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "Keep /tmp/x" },
        ],
        overflow: false,
      };
    },
  });
  const deps: CoordinatorDeps = {
    runtime: {
      mode: () => "tui",
      isIdle: () => true,
      getDraft: () => draft,
      setDraft: (value) => {
        draft = value;
      },
      notify: (message, type) => notices.push([message, type]),
      getActiveContextEntries: () => [],
    },
    settings: { load: async () => ({ ok: true, settings: defaultSettings() }) },
    improverModel: {
      prepare: async () => ({ ok: true, invocation }),
    },
    ui: {
      beginSetup: (metadata) => {
        setupMetadata.push(metadata);
        return completedSetup();
      },
      runWithLoader: async (metadata, task) => {
        loaderMetadata.push(metadata);
        return {
          kind: "success",
          value: await task(new AbortController().signal),
        };
      },
      preview: async (input) => {
        previews.push(input);
        return "replace";
      },
    },
    ...overrides,
  };
  return {
    coordinator: new OperationCoordinator(deps),
    deps,
    notices,
    requests,
    previews,
    loaderMetadata,
    setupMetadata,
    invocation,
    getDraft: () => draft,
  };
}

describe("OperationCoordinator", () => {
  it("preserves the draft and allows another invocation after setup fails", async () => {
    const h = harness();
    const original = h.getDraft();
    const beginSetup = h.deps.ui.beginSetup;
    h.deps.ui.beginSetup = () => {
      throw new Error("Setup unavailable");
    };
    await h.coordinator.run();
    expect(h.getDraft()).toBe(original);
    expect(h.notices.at(-1)?.[0]).toContain("Setup unavailable");
    h.deps.ui.beginSetup = beginSetup;
    await h.coordinator.run();
    expect(h.requests).toHaveLength(1);
  });

  it("runs isolated default flow and replaces only after preview confirmation", async () => {
    const h = harness();
    await h.coordinator.run();

    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as {
      systemInstruction: string;
      messages: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
    };
    expect(h.invocation.identity).toBe("anthropic/sonnet");
    expect(request.systemInstruction).toContain(defaultSettings().instruction);
    expect(request.systemInstruction).toContain(
      "DRAFT_TO_REWRITE is the only transformation target",
    );
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content[0]?.text).toContain(
      "make endpoint\r\nkeep /tmp/x",
    );
    expect(request.messages[0]?.content[0]?.text).not.toContain(
      "REFERENCE_CONTEXT",
    );
    expect(h.previews[0]).toMatchObject({ thinking: "default" });
    expect(h.getDraft()).toBe("Make endpoint clearly.\nKeep /tmp/x");
    expect(h.notices).toContainEqual(["Prompt replaced", "info"]);
  });

  it.each([
    ["rpc", true, "draft", "Prompt Improver requires interactive TUI mode"],
    ["tui", true, "   ", "Enter a draft before improving it"],
  ] as const)(
    "guards mode=%s idle=%s draft=%s",
    async (mode, idle, initial, expected) => {
      let draft: string = initial;
      const prepare = vi.fn();
      const h = harness({
        runtime: {
          mode: () => mode,
          isIdle: () => idle,
          getDraft: () => draft,
          setDraft: (next) => (draft = next),
          notify: (message, type) => h.notices.push([message, type]),
          getActiveContextEntries: () => [],
        },
        improverModel: { prepare },
      });
      await h.coordinator.run();
      expect(prepare).not.toHaveBeenCalled();
      expect(draft).toBe(initial);
      expect(h.notices[0]?.[0]).toBe(expected);
    },
  );

  it("runs while Pi is non-idle and marks concurrent-run UI", async () => {
    const h = harness({
      runtime: {
        mode: () => "tui",
        isIdle: () => false,
        getDraft: () => "steer this work",
        setDraft: vi.fn(),
        notify: vi.fn(),
        getActiveContextEntries: () => [],
      },
    });

    await h.coordinator.run();

    expect(h.requests).toHaveLength(1);
    expect(h.setupMetadata[0]).toMatchObject({ mainRunContinues: true });
    expect(h.loaderMetadata[0]).toMatchObject({ mainRunContinues: true });
    expect(h.previews[0]).toMatchObject({ mainRunContinues: true });
  });

  it("cancels during non-settling setup without invoking the model", async () => {
    const controller = new AbortController();
    const prepare = vi.fn();
    const dispose = vi.fn();
    const h = harness({
      settings: { load: () => new Promise<never>(() => undefined) },
      improverModel: { prepare },
      ui: {
        beginSetup: () => ({ signal: controller.signal, dispose }),
        runWithLoader: vi.fn(),
        preview: vi.fn(),
      },
    });

    const operation = h.coordinator.run();
    controller.abort();
    const outcome = await Promise.race([
      operation.then(() => "settled" as const),
      new Promise<"blocked">((resolveBlocked) =>
        setTimeout(() => resolveBlocked("blocked"), 25),
      ),
    ]);

    expect(outcome).toBe("settled");
    expect(dispose).toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    expect(h.notices).toContainEqual(["Improvement cancelled", "info"]);
  });

  it("ignores late setup rejection after cancellation", async () => {
    const controller = new AbortController();
    const prepare = vi.fn();
    let rejectSettings!: (error: Error) => void;
    const settings = new Promise<never>((_resolve, reject) => {
      rejectSettings = reject;
    });
    const h = harness({
      settings: { load: () => settings },
      improverModel: { prepare },
      ui: {
        beginSetup: () => ({
          signal: controller.signal,
          dispose: vi.fn(),
        }),
        runWithLoader: vi.fn(),
        preview: vi.fn(),
      },
    });

    const operation = h.coordinator.run();
    controller.abort();
    await operation;
    rejectSettings(new Error("late settings failure"));
    await Promise.resolve();

    expect(prepare).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    expect(h.notices).toEqual([["Improvement cancelled", "info"]]);
  });

  it("snapshots finalized context synchronously at invocation", async () => {
    let releaseSettings!: (
      value: Awaited<ReturnType<CoordinatorDeps["settings"]["load"]>>,
    ) => void;
    const settingsWait = new Promise<
      Awaited<ReturnType<CoordinatorDeps["settings"]["load"]>>
    >((resolve) => {
      releaseSettings = resolve;
    });
    let entries: unknown[] = [
      { type: "message", message: { role: "user", content: "at invocation" } },
    ];
    const settings = {
      ...defaultSettings(),
      context: { enabled: true, count: 1 },
    };
    const h = harness({
      settings: { load: () => settingsWait },
      runtime: {
        mode: () => "tui",
        isIdle: () => false,
        getDraft: () => "current steering draft",
        setDraft: vi.fn(),
        notify: vi.fn(),
        getActiveContextEntries: () => entries,
      },
    });

    const run = h.coordinator.run();
    entries = [
      { type: "message", message: { role: "user", content: "finished later" } },
    ];
    releaseSettings({ ok: true, settings });
    await run;

    const request = h.requests[0] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const payload = request.messages[0]?.content[0]?.text ?? "";
    expect(payload).toContain("at invocation");
    expect(payload).not.toContain("finished later");
  });

  it("serializes exact selected context as reference data before current draft", async () => {
    const settings = {
      ...defaultSettings(),
      context: { enabled: true, count: 2 },
    };
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      runtime: {
        mode: () => "tui",
        isIdle: () => true,
        getDraft: () => "current",
        setDraft: () => {},
        notify: () => {},
        getActiveContextEntries: () => [
          { type: "message", message: { role: "user", content: "old" } },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "recent" }],
            },
          },
          { type: "message", message: { role: "user", content: "latest" } },
        ],
      },
    });
    await h.coordinator.run();
    const request = h.requests[0] as {
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    const payload = request.messages[0]?.content[0]?.text ?? "";
    expect(payload).not.toContain("old");
    expect(payload).toContain("[ASSISTANT MESSAGE]\nrecent");
    expect(payload).toContain("[USER MESSAGE]\nlatest");
    expect(payload).toContain("DRAFT_TO_REWRITE");
    expect(payload).toContain("current");
    expect(payload.indexOf("recent")).toBeLessThan(payload.indexOf("latest"));
    expect(payload.indexOf("latest")).toBeLessThan(payload.indexOf("current"));
  });

  it("preserves newer editor text when draft changes before Replace", async () => {
    let draft = "captured draft";
    const notices: Array<[string, string]> = [];
    const h = harness({
      runtime: {
        mode: () => "tui",
        isIdle: () => false,
        getDraft: () => draft,
        setDraft: (value) => {
          draft = value;
        },
        notify: (message, type) => notices.push([message, type]),
        getActiveContextEntries: () => [],
      },
      improverModel: {
        prepare: async () => ({
          ok: true,
          invocation: createInvocation({
            completeImpl: async () => {
              draft = "newer steering draft";
              return {
                content: [{ type: "text", text: "improved captured draft" }],
                overflow: false,
              };
            },
          }),
        }),
      },
    });

    await h.coordinator.run();

    expect(draft).toBe("newer steering draft");
    expect(notices).toContainEqual([
      "Draft changed while Prompt Improver was running. Current draft was preserved. Run Prompt Improver again to improve the latest text.",
      "warning",
    ]);
    expect(notices).not.toContainEqual(["Prompt replaced", "info"]);
  });

  it("keeps original on preview Keep, cancellation, overflow, and malformed settings", async () => {
    for (const variant of ["keep", "cancel", "overflow", "settings"] as const) {
      const h = harness(
        variant === "keep"
          ? {
              ui: {
                beginSetup: completedSetup,
                runWithLoader: async (_m, task) => ({
                  kind: "success",
                  value: await task(new AbortController().signal),
                }),
                preview: async () => "keep",
              },
            }
          : variant === "cancel"
            ? {
                ui: {
                  beginSetup: completedSetup,
                  runWithLoader: async () => ({ kind: "cancelled" }),
                  preview: async () => "replace",
                },
              }
            : variant === "overflow"
              ? {
                  improverModel: {
                    prepare: async () => ({
                      ok: true,
                      invocation: createInvocation({
                        completeImpl: async () => ({
                          content: [],
                          overflow: true,
                        }),
                      }),
                    }),
                  },
                }
              : {
                  settings: {
                    load: async () => ({
                      ok: false,
                      error: "Malformed settings file",
                    }),
                  },
                },
      );
      const before = h.getDraft();
      await h.coordinator.run();
      expect(h.getDraft(), variant).toBe(before);
    }
  });

  it("retries generation from the same original until user replaces", async () => {
    let attempt = 0;
    const requestPayloads: string[] = [];
    const invocation = createInvocation({
      completeImpl: async (input) => {
        requestPayloads.push(
          JSON.stringify({
            systemInstruction: input.systemInstruction,
            messages: input.messages,
          }),
        );
        return {
          content: [{ type: "text", text: `attempt ${++attempt}` }],
          overflow: false,
        };
      },
    });
    const previewInputs: Array<{ original: string; improved: string }> = [];
    const h = harness({
      improverModel: {
        prepare: async () => ({ ok: true, invocation }),
      },
      ui: {
        beginSetup: completedSetup,
        runWithLoader: async (_meta, task) => ({
          kind: "success",
          value: await task(new AbortController().signal),
        }),
        preview: async (input) => {
          previewInputs.push(input);
          return previewInputs.length === 1 ? "retry" : "replace";
        },
      },
    });

    await h.coordinator.run();

    expect(requestPayloads).toHaveLength(2);
    expect(requestPayloads[1]).toBe(requestPayloads[0]);
    expect(previewInputs).toEqual([
      expect.objectContaining({
        original: "make endpoint\r\nkeep /tmp/x",
        improved: "attempt 1",
      }),
      expect.objectContaining({
        original: "make endpoint\r\nkeep /tmp/x",
        improved: "attempt 2",
      }),
    ]);
    expect(h.getDraft()).toBe("attempt 2");
  });

  it.each(["keep", "cancel", "error"] as const)(
    "preserves original when %s occurs after a retry",
    async (variant) => {
      let completionCount = 0;
      let loaderCount = 0;
      let previewCount = 0;
      const h = harness({
        improverModel: {
          prepare: async () => ({
            ok: true,
            invocation: createInvocation({
              completeImpl: async () => {
                completionCount++;
                if (variant === "error" && completionCount === 2) {
                  throw new Error("second attempt failed");
                }
                return {
                  content: [
                    { type: "text", text: `attempt ${completionCount}` },
                  ],
                  overflow: false,
                };
              },
            }),
          }),
        },
        ui: {
          beginSetup: completedSetup,
          runWithLoader: async (_meta, task) => {
            loaderCount++;
            if (variant === "cancel" && loaderCount === 2) {
              return { kind: "cancelled" };
            }
            try {
              return {
                kind: "success",
                value: await task(new AbortController().signal),
              };
            } catch (error) {
              return { kind: "error", error };
            }
          },
          preview: async () => (++previewCount === 1 ? "retry" : "keep"),
        },
      });
      const original = h.getDraft();

      await h.coordinator.run();

      expect(h.getDraft()).toBe(original);
      expect(completionCount).toBe(variant === "cancel" ? 1 : 2);
    },
  );

  it("keeps operation lock held across retries", async () => {
    let previewCount = 0;
    let releaseSecond!: () => void;
    const secondAttempt = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let completionCount = 0;
    const h = harness({
      improverModel: {
        prepare: async () => ({
          ok: true,
          invocation: createInvocation({
            completeImpl: async () => {
              completionCount++;
              if (completionCount === 2) await secondAttempt;
              return {
                content: [{ type: "text", text: `attempt ${completionCount}` }],
                overflow: false,
              };
            },
          }),
        }),
      },
      ui: {
        beginSetup: completedSetup,
        runWithLoader: async (_meta, task) => ({
          kind: "success",
          value: await task(new AbortController().signal),
        }),
        preview: async () => (++previewCount === 1 ? "retry" : "keep"),
      },
    });

    const firstRun = h.coordinator.run();
    while (completionCount < 2) await Promise.resolve();
    await h.coordinator.run();

    expect(h.notices).toContainEqual([
      "Prompt improvement already in progress",
      "warning",
    ]);
    releaseSecond();
    await firstRun;
  });

  it("prepares Fast mode only for supported Codex models", async () => {
    const settings = { ...defaultSettings(), fastMode: true };
    const requests: unknown[] = [];
    const preparedInvocation = createInvocation({
      identity: "openai-codex/gpt-5.5",
      fastModeRequested: true,
      completeImpl: async (input) => {
        requests.push(input);
        return {
          content: [{ type: "text", text: "done" }],
          overflow: false,
        };
      },
    });
    const prepare = vi.fn(async () => ({
      ok: true as const,
      invocation: preparedInvocation,
    }));
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      improverModel: { prepare },
    });

    await h.coordinator.run();

    expect(prepare).toHaveBeenCalledWith(settings);
    expect(preparedInvocation.fastModeRequested).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("fails closed when Fast mode is enabled for an unsupported model", async () => {
    const settings = { ...defaultSettings(), fastMode: true };
    const prepare = vi.fn(async () => ({
      ok: false as const,
      error:
        "Fast mode is only supported for openai-codex Codex Responses models",
    }));
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      improverModel: { prepare },
    });

    await h.coordinator.run();

    expect(h.requests).toHaveLength(0);
    expect(h.notices[0]?.[0]).toContain(
      "Fast mode is only supported for openai-codex Codex Responses models",
    );
  });

  it("preserves the draft when a supported Codex provider rejects Fast mode", async () => {
    const settings = { ...defaultSettings(), fastMode: true };
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      improverModel: {
        prepare: async () => ({
          ok: true,
          invocation: createInvocation({
            identity: "openai-codex/gpt-5.5",
            fastModeRequested: true,
            completeImpl: async () => {
              throw new Error("Provider rejected Fast mode");
            },
          }),
        }),
      },
    });
    const original = h.getDraft();

    await h.coordinator.run();

    expect(h.getDraft()).toBe(original);
    expect(h.notices).toContainEqual([
      "Prompt improvement failed for openai-codex/gpt-5.5: Provider rejected Fast mode",
      "error",
    ]);
  });

  it("reuses the same prepared invocation across retries", async () => {
    const settings = {
      ...defaultSettings(),
      fastMode: true,
      thinking: "off" as const,
    };
    let completeCount = 0;
    const invocation = createInvocation({
      identity: "openai-codex/gpt-5.5",
      fastModeRequested: true,
      completeImpl: async () => ({
        content: [{ type: "text", text: `attempt ${++completeCount}` }],
        overflow: false,
      }),
    });
    const prepare = vi.fn(async () => ({ ok: true as const, invocation }));
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      improverModel: { prepare },
      ui: {
        beginSetup: completedSetup,
        runWithLoader: async (_metadata, task) => ({
          kind: "success",
          value: await task(new AbortController().signal),
        }),
        preview: async () => (completeCount === 1 ? "retry" : "replace"),
      },
    });

    await h.coordinator.run();

    expect(completeCount).toBe(2);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("passes supported thinking to confirmation status", async () => {
    const settings = { ...defaultSettings(), thinking: "high" as const };
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
    });

    await h.coordinator.run();

    expect(h.previews[0]).toMatchObject({ thinking: "high" });
  });

  it("fails closed for unsupported thinking and releases operation lock after failures", async () => {
    const settings = { ...defaultSettings(), thinking: "max" as const };
    const prepare = vi.fn(async () => ({
      ok: false as const,
      error: "Thinking level max is not supported by anthropic/sonnet",
      identity: "anthropic/sonnet",
    }));
    const h = harness({
      settings: { load: async () => ({ ok: true, settings }) },
      improverModel: { prepare },
    });

    await h.coordinator.run();
    await h.coordinator.run();

    expect(h.requests).toHaveLength(0);
    expect(h.notices.filter(([m]) => m.includes("not supported"))).toHaveLength(
      2,
    );
  });

  it("rejects overlapping runs and releases lock after asynchronous completion", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => (finish = resolve));
    const h = harness({
      improverModel: {
        prepare: async () => ({
          ok: true,
          invocation: createInvocation({
            completeImpl: async () => {
              await wait;
              return {
                content: [{ type: "text", text: "done" }],
                overflow: false,
              };
            },
          }),
        }),
      },
    });
    const first = h.coordinator.run();
    await Promise.resolve();
    await h.coordinator.run();
    expect(h.notices).toContainEqual([
      "Prompt improvement already in progress",
      "warning",
    ]);
    finish();
    await first;
    await h.coordinator.run();
    expect(h.notices.filter(([m]) => m === "Prompt replaced")).toHaveLength(2);
  });

  it("fails closed for stale settings through the real runtime without preview or transport", async () => {
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
    const complete = vi.fn();
    const runtime = new ImproverModelRuntime(
      {
        find: vi.fn(() => baseModel),
        getAvailable: vi.fn(() => [baseModel]),
        getApiKeyAndHeaders: vi.fn(),
        complete,
        getProvider: vi.fn(),
        getRegisteredNativeProvider: vi.fn(),
        getRegisteredProviderConfig: vi.fn(),
      },
      () => baseModel as never,
      () => ["off"],
    );
    const h = harness({
      settings: {
        load: async () => ({
          ok: true,
          settings: { ...defaultSettings(), thinking: "high" },
        }),
      },
      improverModel: runtime,
    });

    await h.coordinator.run();

    expect(complete).not.toHaveBeenCalled();
    expect(h.previews).toHaveLength(0);
    expect(h.getDraft()).toBe("make endpoint\r\nkeep /tmp/x");
    expect(
      h.notices.some(([message]) => message.includes("not supported")),
    ).toBe(true);
  });

  it("preserves the draft when the real runtime classifies provider overflow", async () => {
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
    const overflowResponse: AssistantMessage = {
      role: "assistant",
      content: [],
      api: baseModel.api,
      provider: baseModel.provider,
      model: baseModel.id,
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      timestamp: 1,
    };
    const nativeStream = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.end(overflowResponse);
      return stream;
    });
    const runtime = new ImproverModelRuntime(
      {
        find: vi.fn(() => baseModel),
        getAvailable: vi.fn(() => [baseModel]),
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
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
    const h = harness({ improverModel: runtime });

    await h.coordinator.run();

    expect(h.previews).toHaveLength(0);
    expect(h.getDraft()).toBe("make endpoint\r\nkeep /tmp/x");
    expect(
      h.notices.some(([message]) => message.includes("context window")),
    ).toBe(true);
  });
});
