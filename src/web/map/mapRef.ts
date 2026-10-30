import type { WarMap } from "./engine";
import type { OrbitScene } from "./orbit";

/** Shared handles between the map and the HUD (hotkeys, intel camera, focus). */
export const mapRef: {
  map: WarMap | null;
  orbit: OrbitScene | null;
  camBox: HTMLElement | null;
  positions: Map<string, { x: number; z: number }>;
} = {
  map: null,
  orbit: null,
  camBox: null,
  positions: new Map(),
};
