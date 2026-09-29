import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ImproverModelRuntime } from "../src/improver-model-runtime.js";
import { assertPromptImproverPiSupport } from "../src/pi-compat.js";
import { buildPromptProtocol } from "../src/prompt-protocol.js";
import { defaultSettings } from "../src/settings-store.js";

// Use Pi's real registry, composition, auth, and transcript interfaces without
// accessing personal settings, credentials, model catalogs, or the network.
describe("current Pi runtime integration", () => {
  it("preserves the rewrite protocol through native and composed provider dispatch", async () => {
    const host = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(host);
    assertPromptImproverPiSupport(registry);
    const model: Model<"test-api"> = {
      id: "rewrite",
      provider: "prompt-improve-integration",
      name: "Offline rewrite test",
      api: "test-api",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 1000,
    };
    const calls: TranscriptContext[] = [];
    const respond: Provider["stream"] = (_model, context) => {
      calls.push(context);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Rewrite this synthetic draft." }],
        stopReason: "stop",
        timestamp: 1,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.end(message);
      return stream;
    };
    registry.registerProvider({
      id: model.provider,
      name: "Offline integration provider",
      auth: {
        apiKey: {
          name: "Keyless test auth",
          resolve: async () => ({ auth: {} }),
        },
      },
      getModels: () => [model],
      stream: respond,
      streamSimple: respond,
    });
    try {
      const runtime = new ImproverModelRuntime(registry, () => model);
      const protocol = buildPromptProtocol(
        defaultSettings().instruction,
        [],
        "synthetic draft",
      );
      for (const thinking of ["default", "off", "high"] as const) {
        const prepared = await runtime.prepare({
          ...defaultSettings(),
          thinking,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error(prepared.error);
        const result = await prepared.invocation.complete({
          ...protocol,
          signal: new AbortController().signal,
        });
        expect(result.overflow).toBe(false);
        expect(result.content).toEqual([
          { type: "text", text: "Rewrite this synthetic draft." },
        ]);
      }
      expect(calls).toHaveLength(3);
      for (const context of calls) {
        expect(context.messages.map((message) => message.role)).toEqual([
          "system",
          "user",
        ]);
        expect(getCurrentSystemPrompt(context.messages)).toBe(
          protocol.systemInstruction,
        );
        expect(context.messages[1]).toMatchObject(protocol.messages[0]!);
      }
    } finally {
      registry.unregisterProvider(model.provider);
    }
  });
});
