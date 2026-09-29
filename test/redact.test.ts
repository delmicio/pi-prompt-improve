import { describe, expect, it } from "vitest";
import { redactError } from "../src/redact.js";

describe("redactError", () => {
  it("handles errors that cannot be serialized as JSON", () => {
    for (const error of [undefined, Symbol("private"), () => {}]) {
      expect(redactError(error)).toBe("Unknown provider error");
    }
  });

  it("redacts common credential forms while preserving model identity", () => {
    const input = new Error(
      "anthropic/sonnet Authorization: Bearer abc.def API_KEY=sk-secret https://x.test?a=1&token=secret&safe=yes",
    );
    const value = redactError(input);
    expect(value).toContain("anthropic/sonnet");
    expect(value).toContain("[REDACTED]");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("sk-secret");
    expect(value).not.toContain("token=secret");
    expect(value).toContain("safe=yes");
  });

  it("redacts nested provider error values", () => {
    expect(
      redactError({ error: { headers: { authorization: "Basic xyz" } } }),
    ).not.toContain("xyz");
  });
});
