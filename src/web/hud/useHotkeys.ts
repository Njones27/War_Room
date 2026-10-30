import { useEffect } from "react";
import { squadOrder, useStore } from "../lib/store";
import { mapRef } from "../map/mapRef";
import { cycleAgent, viewAgent } from "./viewAgent";
import { leaveOrbit, toggleOrbit } from "../map/OrbitView";

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

/** Keys in orbit: SPACE launch, Q/E cycle satellites, R reset, Esc deselect then back to the city. */
function orbitKey(e: KeyboardEvent): void {
  const s = useStore.getState();
  const orbit = mapRef.orbit;
  const sats = Object.values(s.satellites).sort((a, b) => a.createdAt - b.createdAt);
  const cycle = (dir: number) => {
    if (!sats.length) return;
    const i = sats.findIndex((x) => x.id === s.selectedSatelliteId);
    const next = sats[(i + dir + sats.length) % sats.length]!;
    s.set({ selectedSatelliteId: next.id });
  };
  switch (e.key) {
    case " ":
      e.preventDefault();
      s.set({ launchOpen: true, launchEdit: null });
      return;
    case "q":
    case "Q":
      cycle(-1);
      return;
    case "e":
    case "E":
      cycle(1);
      return;
    case "r":
    case "R":
      orbit?.resetCamera();
      return;
    case "o":
    case "O":
      s.set({ objectivesOpen: true });
      return;
    case "p":
    case "P":
      s.set({ settingsOpen: true });
      return;
    case "Escape":
      if (s.selectedSatelliteId) s.set({ selectedSatelliteId: null });
      else leaveOrbit();
      return;
    case "+":
    case "=":
      orbit?.zoomBy(0.8);
      return;
    case "-":
    case "_":
      orbit?.zoomBy(1.25);
      return;
  }
}

/** BF6-style keys: SPACE deploy, Q/E cycle agents, Z ping, R reset, O objectives, P settings, F full-screen intel, 1–9 select. */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      if (s.deployOpen || s.manageOpen || s.objectivesOpen || s.settingsOpen || s.launchOpen || s.terminalFor) return;
      if (e.key === "g" || e.key === "G") {
        toggleOrbit();
        return;
      }
      if (s.view === "orbit") {
        orbitKey(e);
        return;
      }
      const map = mapRef.map;
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.set({ deployOpen: true, selectedRole: null });
          return;
        case "q":
        case "Q":
          cycleAgent(-1);
          return;
        case "e":
        case "E":
          cycleAgent(1);
          return;
        case "z":
        case "Z":
          s.set({ pingMode: !s.pingMode });
          return;
        case "r":
        case "R":
          map?.resetCamera();
          return;
        case "o":
        case "O":
          s.set({ objectivesOpen: true });
          return;
        case "p":
        case "P":
          s.set({ settingsOpen: true });
          return;
        case "f":
        case "F":
          if (s.selectedAgentId) s.set({ intelFull: !s.intelFull });
          return;
        case "Escape":
          if (s.pingMode) s.set({ pingMode: false });
          else if (s.intelFull) s.set({ intelFull: false });
          else s.select(null);
          return;
        case "+":
        case "=":
          map?.zoomBy(0.8);
          return;
        case "-":
        case "_":
          map?.zoomBy(1.25);
          return;
        case "ArrowLeft":
          map?.panBy(80, 0);
          return;
        case "ArrowRight":
          map?.panBy(-80, 0);
          return;
        case "ArrowUp":
          map?.panBy(0, 80);
          return;
        case "ArrowDown":
          map?.panBy(0, -80);
          return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const agent = squadOrder(s.agents)[Number(e.key) - 1];
        if (agent) viewAgent(agent.id, false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Scale the HUD with the window, designed at 1920×1080. */
export function useHudScale(): void {
  useEffect(() => {
    const apply = () => {
      const s = Math.max(0.62, Math.min(1.5, Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
      document.documentElement.style.fontSize = `${16 * s}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}
