import type { WarMap } from "./engine";

/** Shared handles between the map and the HUD (hotkeys, intel camera, focus). */
export const mapRef: {
  map: WarMap | null;
  camBox: HTMLElement | null;
  positions: Map<string, { x: number; z: number }>;
} = {
  map: null,
  camBox: null,
  positions: new Map(),
};
