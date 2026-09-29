import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/extension.js";
import { CURSOR_SDK_ISOLATION_ERROR } from "../src/improver-model-runtime.js";
import { MIN_PI_VERSION } from "../src/pi-compat.js";
import { defaultSettings } from "../src/settings-store.js";
import { resetWarningStateForTests } from "../src/status.js";

async function createSettingsHome(settings: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "prompt-improve-startup-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "prompt-improve.json"),
    JSON.stringify(settings),
  );
  return home;
}

function compatibleRegistry(overrides: Record<string, unknown> = {}) {
  return {
    complete: vi.fn(async () => ({})),
    getProvider: vi.fn(() => undefined),
    getRegisteredNativeProvider: vi.fn(() => undefined),
    getRegisteredProviderConfig: vi.fn(() => undefined),
    find: vi.fn(),
    getAvailable: vi.fn(() => []),
    getApiKeyAndHeaders: vi.fn(),
    ...overrides,
  };
}

describe("extension registration", () => {
  it("registers exactly two shortcuts and one command namespace without tools or input hooks", () => {
    const shortcuts: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerShortcut: (key: string) => shortcuts.push(key),
      registerCommand: (name: string) => commands.push(name),
      registerTool: vi.fn(),
      on: (name: string) => events.push(name),
    };

    extension(pi as never, { homeDirectory: "/tmp/home" });

    expect(shortcuts).toEqual(["super+i", "ctrl+shift+i"]);
    expect(commands).toEqual(["prompt-improve"]);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(events).not.toContain("input");
    expect(events).not.toContain("message_start");
    expect(events).not.toContain("message_update");
    expect(events).not.toContain("message_end");
  });

  it("snapshots active model before asynchronous setup while non-idle", async () => {
    let improve: ((ctx: unknown) => Promise<void>) | undefined;
    let authModel: { provider: string; id: string } | undefined;
    const model = (provider: string, id: string) => ({
      api: "openai-completions",
      provider,
      id,
      name: id,
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    });
    const firstModel = model("provider-a", "model-a");
    const ctx = {
      mode: "tui",
      model: firstModel,
      isIdle: () => false,
      ui: {
        getEditorText: () => "steer the current work",
        setEditorText: vi.fn(),
        notify: vi.fn(),
        setWidget: vi.fn(),
        onTerminalInput: () => vi.fn(),
      },
      sessionManager: {
        buildContextEntries: () => [],
      },
      modelRegistry: compatibleRegistry({
        getRegisteredNativeProvider: vi.fn(() => ({
          id: "provider-a",
          name: "provider-a",
          auth: {},
          getModels: () => [firstModel],
          stream: vi.fn(),
          streamSimple: vi.fn(),
        })),
        getApiKeyAndHeaders: async (selected: {
          provider: string;
          id: string;
        }) => {
          authModel = selected;
          return { ok: false as const, error: "stop before provider call" };
        },
      }),
    };
    extension(
      {
        registerShortcut: (
          _key: string,
          options: { handler: typeof improve },
        ) => {
          improve ??= options.handler;
        },
        registerCommand: vi.fn(),
        on: vi.fn(),
      } as never,
      { homeDirectory: `/tmp/prompt-improve-model-snapshot-${Date.now()}` },
    );

    const run = improve?.(ctx);
    ctx.model = model("provider-b", "model-b");
    await run;

    expect(authModel).toMatchObject({ provider: "provider-a", id: "model-a" });
  });

  it("returns from session startup without refreshing the model registry", async () => {
    const home = await createSettingsHome({
      ...defaultSettings(),
      model: { mode: "fixed", provider: "missing", model: "model" },
    });
    const events = new Map<string, (...args: unknown[]) => unknown>();
    const refresh = vi.fn(() => new Promise<void>(() => undefined));
    const notify = vi.fn();
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: vi.fn(),
        on: (name: string, handler: (...args: unknown[]) => unknown) =>
          events.set(name, handler),
      } as never,
      { homeDirectory: home },
    );
    const ctx = {
      model: undefined,
      modelRegistry: {
        refresh,
        find: vi.fn(() => undefined),
        getAvailable: vi.fn(() => []),
      },
      sessionManager: { getSessionId: () => `startup-${Date.now()}` },
      ui: { notify },
    };

    const result = events.get("session_start")?.({}, ctx);

    try {
      expect(result).toBeUndefined();
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("warns once for active cursor-sdk models at session startup", async () => {
    resetWarningStateForTests();
    const home = await createSettingsHome(defaultSettings());
    const events = new Map<string, (...args: unknown[]) => unknown>();
    const notify = vi.fn();
    const cursorModel = {
      api: "cursor-sdk",
      provider: "cursor",
      id: "agent",
      name: "agent",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    };
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: vi.fn(),
        on: (name: string, handler: (...args: unknown[]) => unknown) =>
          events.set(name, handler),
      } as never,
      { homeDirectory: home },
    );
    const ctx = {
      model: cursorModel,
      modelRegistry: compatibleRegistry(),
      sessionManager: { getSessionId: () => `active-cursor-${Date.now()}` },
      ui: { notify },
    };

    events.get("session_start")?.({}, ctx);

    try {
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(CURSOR_SDK_ISOLATION_ERROR),
        "warning",
      );
      events.get("session_start")?.({}, ctx);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    } finally {
      resetWarningStateForTests();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("suppresses detached startup warnings after session shutdown", async () => {
    const home = await createSettingsHome({
      ...defaultSettings(),
      context: { enabled: true, count: 20 },
    });
    const events = new Map<string, (...args: unknown[]) => unknown>();
    const notify = vi.fn();
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: vi.fn(),
        on: (name: string, handler: (...args: unknown[]) => unknown) =>
          events.set(name, handler),
      } as never,
      { homeDirectory: home },
    );
    const ctx = {
      model: undefined,
      modelRegistry: compatibleRegistry(),
      sessionManager: { getSessionId: () => `shutdown-${Date.now()}` },
      ui: { notify },
    };

    events.get("session_start")?.({}, ctx);
    events.get("session_shutdown")?.({}, ctx);

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("includes Fast mode off in reset confirmation", async () => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const confirm = vi.fn(async () => false);
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: (_name: string, options: unknown) => {
          handler = (options as { handler: typeof handler }).handler;
        },
        on: vi.fn(),
      } as never,
      { homeDirectory: `/tmp/prompt-improve-reset-${Date.now()}` },
    );

    await handler?.("reset", {
      mode: "tui",
      isIdle: () => true,
      model: undefined,
      modelRegistry: compatibleRegistry(),
      ui: { confirm, notify: vi.fn() },
    });

    expect(confirm).toHaveBeenCalledWith(
      "Reset Prompt Improver?",
      expect.stringContaining("Fast mode off"),
    );
  });

  it("resets persisted Fast mode to off after confirmation", async () => {
    const home = await createSettingsHome({
      ...defaultSettings(),
      fastMode: true,
    });
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: (_name: string, options: unknown) => {
          handler = (options as { handler: typeof handler }).handler;
        },
        on: vi.fn(),
      } as never,
      { homeDirectory: home },
    );

    await handler?.("reset", {
      mode: "tui",
      isIdle: () => true,
      model: undefined,
      modelRegistry: compatibleRegistry(),
      ui: {
        confirm: vi.fn(async () => true),
        notify: vi.fn(),
      },
    });

    const saved = JSON.parse(
      await readFile(join(home, ".pi", "agent", "prompt-improve.json"), "utf8"),
    ) as { fastMode?: boolean };
    expect(saved.fastMode).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  it("rejects Pi registries missing required ModelRegistry methods during improvement", async () => {
    let improve: ((ctx: unknown) => Promise<void>) | undefined;
    extension(
      {
        registerShortcut: (
          _key: string,
          options: { handler: typeof improve },
        ) => {
          improve = options.handler;
        },
        registerCommand: vi.fn(),
        on: vi.fn(),
      } as never,
      { homeDirectory: `/tmp/prompt-improve-pi-guard-${Date.now()}` },
    );

    await expect(
      improve?.({
        mode: "tui",
        isIdle: () => true,
        model: undefined,
        ui: {
          getEditorText: () => "draft",
          setEditorText: vi.fn(),
          notify: vi.fn(),
        },
        sessionManager: { buildContextEntries: () => [] },
        modelRegistry: {},
      }),
    ).rejects.toThrow(MIN_PI_VERSION);
  });

  it("offers only status and reset argument completions", () => {
    let command:
      | {
          getArgumentCompletions(
            prefix: string,
          ): Array<{ value: string }> | null;
        }
      | undefined;
    extension(
      {
        registerShortcut: vi.fn(),
        registerCommand: (_name: string, options: unknown) =>
          (command = options as never),
        on: vi.fn(),
      } as never,
      { homeDirectory: "/tmp/home" },
    );
    expect(command?.getArgumentCompletions("")?.map((x) => x.value)).toEqual([
      "status",
      "reset",
    ]);
    expect(command?.getArgumentCompletions("st")?.map((x) => x.value)).toEqual([
      "status",
    ]);
    expect(command?.getArgumentCompletions("wat")).toBeNull();
  });
});
