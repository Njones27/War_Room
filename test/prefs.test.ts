import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../src/web/lib/prefs.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  return data;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("prefs", () => {
  it("falls back to defaults without storage", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("round-trips saved preferences", () => {
    fakeStorage();
    const p = { ...DEFAULT_PREFS, quality: "low" as const, effects: "off" as const, vehicles: false, labels: false };
    savePrefs(p);
    expect(loadPrefs()).toEqual(p);
  });

  it("drops invalid or unknown values", () => {
    fakeStorage({ "warroom.prefs": JSON.stringify({ quality: "ultra", effects: "low", vehicles: "no", extra: 1 }) });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, effects: "low" });
  });

  it("survives corrupt storage", () => {
    fakeStorage({ "warroom.prefs": "{not json" });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});
