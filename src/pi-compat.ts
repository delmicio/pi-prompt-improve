import { normalizeContext } from "@earendil-works/pi-ai";

export const MIN_PI_VERSION = "0.99.1";

export function assertPromptImproverPiSupport(registry: unknown): void {
  const candidate = registry as {
    complete?: unknown;
    getProvider?: unknown;
    getRegisteredNativeProvider?: unknown;
    getRegisteredProviderConfig?: unknown;
  };
  if (
    typeof normalizeContext !== "function" ||
    typeof candidate.complete !== "function" ||
    typeof candidate.getProvider !== "function" ||
    typeof candidate.getRegisteredNativeProvider !== "function" ||
    typeof candidate.getRegisteredProviderConfig !== "function"
  ) {
    throw new Error(
      `Prompt Improver requires Pi ${MIN_PI_VERSION} or newer with ModelRegistry.complete(), getProvider(), getRegisteredNativeProvider(), getRegisteredProviderConfig(), and transcript normalization.`,
    );
  }
}
