import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { mapRef } from "./mapRef";
import { OrbitScene } from "./orbit";
import { measureSafeAreas } from "./safeArea";

/** Leave the city for orbit: the map rises, then the Earth takes over. */
export function enterOrbit(): void {
  const s = useStore.getState();
  if (s.view === "orbit") return;
  s.select(null);
  s.set({ view: "orbit", pingMode: false, orbitLeaving: false });
}

/** Dive back down to the city. */
export function leaveOrbit(): void {
  const s = useStore.getState();
  if (s.view !== "orbit" || s.orbitLeaving) return;
  s.set({ orbitLeaving: true, launchOpen: false });
}

export function toggleOrbit(): void {
  if (useStore.getState().view === "orbit") leaveOrbit();
  else enterOrbit();
}

/** The orbit view over the map. The scene is built the first time you go up. */
export function OrbitView() {
  const view = useStore((s) => s.view);
  const leaving = useStore((s) => s.orbitLeaving);
  const satellites = useStore((s) => s.satellites);
  const selected = useStore((s) => s.selectedSatelliteId);
  const launchedId = useStore((s) => s.launchedId);
  const prefs = useStore((s) => s.prefs);
  const theater = useStore((s) => s.theater);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<OrbitScene | null>(null);
  const [shown, setShown] = useState(false);
  const [warm, setWarm] = useState(false);

  // Build the Earth while the app is idle, so the first trip up doesn't stall.
  useEffect(() => {
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 0));
    const t = setTimeout(() => idle(() => setWarm(true)), 2500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if ((view !== "orbit" && !warm) || scene) return;
    const s = new OrbitScene(
      glRef.current!,
      ovRef.current!,
      {
        onPick: (id) => useStore.getState().set({ selectedSatelliteId: id }),
        onWantCity: () => leaveOrbit(),
      },
      (role) => (role ? (useStore.getState().roles.find((r) => r.id === role)?.accessory ?? null) : null),
    );
    mapRef.orbit = s;
    if (import.meta.env.DEV) (window as unknown as { __orbit?: OrbitScene }).__orbit = s;
    setScene(s);
  }, [view, warm, scene]);

  useEffect(
    () => () => {
      mapRef.orbit?.dispose();
      mapRef.orbit = null;
    },
    [],
  );

  // Going up: the city rises and fades as the Earth comes in from just above HQ.
  useEffect(() => {
    if (view !== "orbit" || !scene) return;
    mapRef.map?.pullBack();
    scene.enter();
    const show = setTimeout(() => setShown(true), 300);
    // Stop drawing the city once it's covered, unless we're already heading back down.
    const pause = setTimeout(() => {
      const s = useStore.getState();
      if (s.view === "orbit" && !s.orbitLeaving) mapRef.map?.setPaused(true);
    }, 1600);
    return () => {
      clearTimeout(show);
      clearTimeout(pause);
    };
  }, [view, scene]);

  // Coming down: dive to HQ, then the city lands in its place.
  useEffect(() => {
    if (!leaving || !scene) return;
    mapRef.map?.setPaused(false);
    scene.leave(
      () => {
        setShown(false);
        mapRef.map?.land();
      },
      () => useStore.getState().set({ view: "city", orbitLeaving: false, selectedSatelliteId: null }),
    );
  }, [leaving, scene]);

  useEffect(() => {
    scene?.setSatellites(Object.values(satellites).sort((a, b) => a.createdAt - b.createdAt));
  }, [scene, satellites]);

  useEffect(() => {
    if (!scene || !launchedId || !satellites[launchedId]) return;
    scene.launch(launchedId);
    useStore.getState().set({ launchedId: null });
  }, [scene, launchedId, satellites]);

  // Keep the Earth clear of the HUD.
  useEffect(() => {
    if (!scene) return;
    // The free area with the most room for an Earth centred on screen.
    const update = () => {
      const gl = glRef.current;
      if (!gl) return;
      const frame = gl.getBoundingClientRect();
      const room = (s: { left: number; right: number; top: number; bottom: number }) =>
        Math.min(frame.width - 2 * Math.max(s.left, s.right), frame.height - 2 * Math.max(s.top, s.bottom));
      scene.setSafeArea(measureSafeAreas(frame).reduce((best, s) => (room(s) > room(best) ? s : best)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [scene, view]);

  useEffect(() => scene?.setSelected(selected), [scene, selected]);
  useEffect(() => scene?.setPrefs(prefs), [scene, prefs]);
  useEffect(() => scene?.setTheater(theater?.name ?? ""), [scene, theater?.name]);

  const empty = view === "orbit" && shown && !leaving && Object.keys(satellites).length === 0;
  return (
    <div className={`orbit-layer${shown ? " on" : ""}`} aria-hidden={view !== "orbit"}>
      <canvas ref={glRef} className="orbit-gl" />
      <canvas ref={ovRef} className="orbit-ov" />
      {empty && (
        <div className="orbit-empty">
          <b>No satellites in orbit</b>
          <span>Each scheduled task flies here as a satellite. Press LAUNCH to put up your first one.</span>
        </div>
      )}
    </div>
  );
}
