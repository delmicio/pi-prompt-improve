import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTRUCTION,
  defaultSettings,
  SettingsStore,
} from "../src/settings-store.js";

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), "prompt-improve-"));
  return join(dir, "prompt-improve.json");
}

describe("SettingsStore", () => {
  it("returns complete defaults when file is missing", async () => {
    const store = new SettingsStore(await tempPath());
    expect(await store.load()).toEqual({
      ok: true,
      settings: defaultSettings(),
    });
    expect(defaultSettings().fastMode).toBe(false);
  });

  it("migrates existing settings to Fast mode off", async () => {
    const path = await tempPath();
    const legacy = { ...defaultSettings(), version: 1 as const };
    delete (legacy as { fastMode?: boolean }).fastMode;
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });

    const result = await new SettingsStore(path).load();

    expect(result).toEqual({
      ok: true,
      settings: { ...defaultSettings(), fastMode: false },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
  });

  it("round-trips valid settings with 0600 permissions", async () => {
    const path = await tempPath();
    const store = new SettingsStore(path);
    const settings = {
      ...defaultSettings(),
      model: { mode: "fixed" as const, provider: "anthropic", model: "sonnet" },
      thinking: "high" as const,
      instruction: "Custom private instruction",
      context: { enabled: true, count: 24 },
    };

    await store.save(settings);

    expect(await store.load()).toEqual({ ok: true, settings });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(settings);
  });

  it("fails closed and preserves malformed files", async () => {
    const path = await tempPath();
    await writeFile(path, "{ definitely broken", { mode: 0o600 });
    const store = new SettingsStore(path);

    const result = await store.load();

    expect(result.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{ definitely broken");
  });

  it("does not expose private settings text in JSON syntax errors", async () => {
    const path = await tempPath();
    const malformed = "PRIVATE_REWRITE_GUIDANCE is not JSON";
    await writeFile(path, malformed, { mode: 0o600 });
    const result = await new SettingsStore(path).load();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Malformed settings file");
      expect(result.error).not.toContain("PRIVATE_REWRITE_GUIDANCE");
    }
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("rejects invalid full documents instead of merging defaults", async () => {
    const path = await tempPath();
    await writeFile(
      path,
      JSON.stringify({
        ...defaultSettings(),
        context: { enabled: true, count: 0 },
      }),
      { mode: 0o600 },
    );

    const result = await new SettingsStore(path).load();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("positive integer");
  });

  it("leaves old settings intact when atomic replacement fails", async () => {
    const path = await tempPath();
    const store = new SettingsStore(path);
    await store.save(defaultSettings());
    const before = await readFile(path, "utf8");
    const failing = new SettingsStore(path, {
      beforeRename: () => {
        throw new Error("simulated interruption");
      },
    });

    await expect(
      failing.save({ ...defaultSettings(), instruction: "new instruction" }),
    ).rejects.toThrow("simulated interruption");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("uses exact required default instruction", () => {
    expect(defaultSettings().instruction).toBe(DEFAULT_INSTRUCTION);
  });
});
