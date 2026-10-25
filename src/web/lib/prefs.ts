// Display preferences: how the map is drawn and what the HUD shows. They live in
// this browser only; agents and the server never see them.

export type Quality = "low" | "medium" | "high";
export type EffectsLevel = "off" | "low" | "medium" | "high";

export interface Prefs {
  /** Render resolution and shadows. */
  quality: Quality;
  /** Explosions, gunfire, smoke, screen shake and the cam's switch glitch. */
  effects: EffectsLevel;
  /** Aircraft over the city. Off: agents walk instead of flying. */
  vehicles: boolean;
  /** Agent name labels under their markers. */
  labels: boolean;
  /** The comms log under SUPPLY. */
  comms: boolean;
  /** The key hints under the title. */
  hints: boolean;
  /** Vignette, dot grids and the ruler. */
  decor: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  quality: "high",
  effects: "high",
  vehicles: true,
  labels: true,
  comms: true,
  hints: true,
  decor: true,
};

const KEY = "warroom.prefs";
const QUALITIES: Quality[] = ["low", "medium", "high"];
const EFFECTS: EffectsLevel[] = ["off", "low", "medium", "high"];

/** Saved preferences, with anything missing or invalid back at its default. */
export function loadPrefs(): Prefs {
  let saved: Partial<Record<keyof Prefs, unknown>> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    /* storage unavailable or corrupt */
  }
  const bool = (k: "vehicles" | "labels" | "comms" | "hints" | "decor") => (typeof saved[k] === "boolean" ? (saved[k] as boolean) : DEFAULT_PREFS[k]);
  return {
    quality: QUALITIES.includes(saved.quality as Quality) ? (saved.quality as Quality) : DEFAULT_PREFS.quality,
    effects: EFFECTS.includes(saved.effects as EffectsLevel) ? (saved.effects as EffectsLevel) : DEFAULT_PREFS.effects,
    vehicles: bool("vehicles"),
    labels: bool("labels"),
    comms: bool("comms"),
    hints: bool("hints"),
    decor: bool("decor"),
  };
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
