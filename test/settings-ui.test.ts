import { describe, expect, it, vi } from "vitest";
import { ImproverModelRuntime } from "../src/improver-model-runtime.js";
import { defaultSettings } from "../src/settings-store.js";
import {
  filterModelChoices,
  ModelSearchSelector,
  fastModeChoices,
  showSettings,
  thinkingChoices,
  type ModelChoice,
} from "../src/settings-ui.js";

const choices: ModelChoice[] = [
  {
    value: "active",
    label: "Active session model",
    searchText: "active session model",
  },
  {
    value: "claude",
    label: "anthropic/claude-sonnet-4-5",
    description: "Claude Sonnet",
    searchText: "anthropic/claude-sonnet-4-5 Claude Sonnet",
  },
  {
    value: "gemini",
    label: "google/gemini-2.5-flash",
    description: "Gemini Flash",
    searchText: "google/gemini-2.5-flash Gemini Flash",
  },
];

describe("model settings choices", () => {
  it("fuzzy-matches model provider, id, and display name case-insensitively", () => {
    expect(
      filterModelChoices(choices, "ANT SON 45").map((item) => item.value),
    ).toEqual(["claude"]);
    expect(
      filterModelChoices(choices, "gmflsh").map((item) => item.value),
    ).toEqual(["gemini"]);
  });

  it("filters rendered choices as the user types and selects the match", () => {
    const done = vi.fn();
    const theme = {
      fg: (_color: string, text: string) => text,
    } as never;
    const selector = new ModelSearchSelector(choices, theme, done);

    selector.handleInput("GMFLSH");

    const rendered = selector.render(100).join("\n");
    expect(rendered).toContain("google/gemini-2.5-flash");
    expect(rendered).not.toContain("anthropic/claude-sonnet-4-5");
    selector.handleInput("\r");
    expect(done).toHaveBeenCalledWith("gemini");
  });

  it("keeps search open when Enter is pressed with no matches", () => {
    const done = vi.fn();
    const theme = {
      fg: (_color: string, text: string) => text,
    } as never;
    const selector = new ModelSearchSelector(choices, theme, done);

    selector.handleInput("no-such-model");
    selector.handleInput("\r");

    expect(selector.render(100).join("\n")).toContain("No matching models");
    expect(done).not.toHaveBeenCalled();
  });

  it("shows Model default plus only supported thinking levels", () => {
    expect(thinkingChoices(["off", "medium", "max"])).toEqual([
      { value: "default", label: "Model default" },
      { value: "off", label: "off" },
      { value: "medium", label: "medium" },
      { value: "max", label: "max" },
    ]);
  });

  it("offers Fast mode only for supported Codex models", () => {
    expect(fastModeChoices(true)).toEqual([
      { value: "off", label: "off" },
      { value: "on", label: "on" },
    ]);
    expect(fastModeChoices(false)).toEqual([{ value: "off", label: "off" }]);
  });
});

describe("model selection reconciliation", () => {
  const codexModel = {
    id: "gpt",
    name: "gpt",
    provider: "codex",
    api: "openai-codex-responses" as const,
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100,
    maxTokens: 10,
  };
  const plainModel = {
    ...codexModel,
    provider: "plain",
    id: "basic",
    api: "test-api" as const,
    reasoning: false,
  };

  function runtime() {
    return new ImproverModelRuntime(
      {
        find: vi.fn((provider: string, id: string) => {
          if (provider === "codex" && id === "gpt") return codexModel as never;
          if (provider === "plain" && id === "basic")
            return plainModel as never;
          return undefined;
        }),
        getAvailable: vi.fn(() => [codexModel, plainModel] as never),
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
        getProvider: vi.fn(),
        getRegisteredNativeProvider: vi.fn(),
        getRegisteredProviderConfig: vi.fn(),
      },
      () => codexModel as never,
      (model) => (model.provider === "codex" ? (["off", "high"] as const) : []),
    );
  }

  it("saves compatible model changes immediately without confirmation", async () => {
    const save = vi.fn(async () => undefined);
    const settings = {
      ...defaultSettings(),
      thinking: "high" as const,
    };
    let calls = 0;
    const confirm = vi.fn();
    const ctx = {
      ui: {
        custom: async () => {
          calls += 1;
          if (calls === 1) {
            return { id: "model", value: "fixed:codex:gpt" };
          }
          return undefined;
        },
        notify: vi.fn(),
        confirm,
      },
    };

    await showSettings(
      ctx as never,
      { save } as never,
      runtime(),
      settings,
      vi.fn(),
    );

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      ...settings,
      model: { mode: "fixed", provider: "codex", model: "gpt" },
    });
  });

  it("requires confirmation before saving dependent setting resets", async () => {
    const save = vi.fn(async () => undefined);
    const settings = {
      ...defaultSettings(),
      model: { mode: "fixed" as const, provider: "codex", model: "gpt" },
      thinking: "high" as const,
      fastMode: true,
    };
    const confirm = vi.fn(async () => true);
    let calls = 0;
    const ctx = {
      ui: {
        custom: async () => {
          calls += 1;
          if (calls === 1) return { id: "model", value: "fixed:plain:basic" };
          return undefined;
        },
        notify: vi.fn(),
        confirm,
      },
    } as never;

    await showSettings(
      ctx as never,
      { save } as never,
      runtime(),
      settings,
      vi.fn(),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({
      ...settings,
      model: { mode: "fixed", provider: "plain", model: "basic" },
      thinking: "default",
      fastMode: false,
    });
  });

  it("performs zero saves when confirmation is declined", async () => {
    const save = vi.fn(async () => undefined);
    const settings = {
      ...defaultSettings(),
      model: { mode: "fixed" as const, provider: "codex", model: "gpt" },
      thinking: "high" as const,
      fastMode: true,
    };
    let calls = 0;
    const ctx = {
      ui: {
        custom: async () => {
          calls += 1;
          if (calls === 1) return { id: "model", value: "fixed:plain:basic" };
          return undefined;
        },
        notify: vi.fn(),
        confirm: vi.fn(async () => false),
      },
    };

    await showSettings(
      ctx as never,
      { save } as never,
      runtime(),
      settings,
      vi.fn(),
    );

    expect(save).not.toHaveBeenCalled();
  });
});
