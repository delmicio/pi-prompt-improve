import { describe, expect, it, vi } from "vitest";
import {
  formatStatus,
  HIGH_CONTEXT_WARNING,
  resetWarningStateForTests,
  warnHighContext,
} from "../src/status.js";
import { CODEX_FAST_MODE_ERROR } from "../src/improver-model-runtime.js";
import { defaultSettings } from "../src/settings-store.js";

describe("status and warning behavior", () => {
  it("warns once per logical session, not while context is off", () => {
    resetWarningStateForTests();
    const notify = vi.fn();
    let session = "one";
    const ctx = {
      sessionManager: { getSessionId: () => session },
      ui: { notify },
    } as never;
    const enabled = {
      ...defaultSettings(),
      context: { enabled: true, count: 20 },
    };
    warnHighContext(ctx, defaultSettings());
    warnHighContext(ctx, enabled);
    warnHighContext(ctx, enabled);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(HIGH_CONTEXT_WARNING(20), "warning");
    session = "two";
    warnHighContext(ctx, enabled);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("shows Fast mode only when requested", async () => {
    const runtime = {
      inspect: async () => ({
        identity: "openai-codex/gpt-5.5",
        supportedThinking: [],
        fastModeSupported: true,
        configurationErrors: [],
      }),
    } as never;

    const off = await formatStatus(defaultSettings(), runtime);
    expect(off).not.toContain("Fast mode");

    const on = await formatStatus(
      { ...defaultSettings(), fastMode: true },
      runtime,
    );
    expect(on).toContain("Fast mode: requested");

    const unsupported = await formatStatus(
      { ...defaultSettings(), fastMode: true },
      {
        inspect: async () => ({
          identity: "anthropic/sonnet",
          supportedThinking: [],
          fastModeSupported: false,
          configurationErrors: [CODEX_FAST_MODE_ERROR],
        }),
      } as never,
    );
    expect(unsupported).toContain("Fast mode is only supported");

    const bothErrors = await formatStatus(
      { ...defaultSettings(), fastMode: true, thinking: "high" },
      {
        inspect: async () => ({
          identity: "anthropic/sonnet",
          supportedThinking: [],
          fastModeSupported: false,
          configurationErrors: [
            "Thinking level high is not supported by anthropic/sonnet",
            CODEX_FAST_MODE_ERROR,
          ],
        }),
      } as never,
    );
    expect(bothErrors).toContain("Thinking level high is not supported");
    expect(bothErrors).toContain("Fast mode is only supported");
  });

  it("shows concise effective configuration without rewrite-guidance content", async () => {
    const settings = {
      ...defaultSettings(),
      instruction: "sensitive custom guidance",
    };
    const text = await formatStatus(settings, {
      inspect: async () => ({
        identity: "p/m",
        supportedThinking: [],
        fastModeSupported: false,
        configurationErrors: [],
      }),
    } as never);
    expect(text).toContain("Model: p/m");
    expect(text).toContain("Rewrite guidance: custom");
    expect(text).toContain("Protocol: fixed context/draft separation");
    expect(text).toContain("Shortcuts: super+i, ctrl+shift+i");
    expect(text).not.toContain("sensitive custom guidance");
  });
});
