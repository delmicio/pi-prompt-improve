import { describe, expect, it } from "vitest";
import {
  assertPromptImproverPiSupport,
  MIN_PI_VERSION,
} from "../src/pi-compat.js";

describe("pi compatibility guard", () => {
  it("accepts registries with complete(), getProvider(), getRegisteredNativeProvider(), and getRegisteredProviderConfig()", () => {
    expect(() =>
      assertPromptImproverPiSupport({
        complete: async () => ({}),
        getProvider: () => undefined,
        getRegisteredNativeProvider: () => undefined,
        getRegisteredProviderConfig: () => undefined,
      }),
    ).not.toThrow();
  });

  it("rejects registries missing required ModelRegistry methods", () => {
    expect(() => assertPromptImproverPiSupport({})).toThrow(MIN_PI_VERSION);
    expect(() =>
      assertPromptImproverPiSupport({ complete: async () => ({}) }),
    ).toThrow(MIN_PI_VERSION);
    expect(() =>
      assertPromptImproverPiSupport({
        complete: async () => ({}),
        getProvider: () => undefined,
        getRegisteredNativeProvider: () => undefined,
      }),
    ).toThrow(MIN_PI_VERSION);
  });
});
