// Orbit view: the Earth in space with each scheduled task as a mascot
// satellite on its own tilted orbit. Three.js draws the globe, the network
// shell, orbits and sprites; a 2D overlay draws the HUD layer (labels,
// the blue Doppler rings and mesh links of running tasks, the HQ marker).
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  Vector4,
  WebGLRenderer,
  type CanvasTexture,
} from "three";
import type { SatelliteView } from "../../shared/protocol";
import type { EffectsLevel, Quality } from "../lib/prefs";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { blankTexture, latticePositions, loadEarthTextures, satelliteSprite } from "./earth";

export interface OrbitEvents {
  onPick(id: string | null): void;
  /** Scrolled in past the closest view: back to the city. */
  onWantCity(): void;
}

const D = Math.PI / 180;
const FOV = 30;
/** The closest the whole-Earth view gets; it moves out to fit the free screen area. */
const HOME_MIN = 7;
const MIN_DIST = 2.6;
const MAX_DIST = 18;
const ACTIVE_SLOTS = 4;
const BLUE = "74,168,255";
const CYAN = "112,235,252";
const ORANGE = "253,134,100";

/** Lat/lon (degrees) → unit vector, matching three's sphere UVs (texture x = lon, y = lat). */
export function ll(lat: number, lon: number): Vector3 {
  const c = Math.cos(lat * D);
  return new Vector3(c * Math.cos(lon * D), Math.sin(lat * D), -c * Math.sin(lon * D));
}

/** HQ sits at this browser's time-zone longitude: roughly where you are. */
function hqLatLon(): { lat: number; lon: number } {
  const lon = Math.max(-170, Math.min(170, (-new Date().getTimezoneOffset() / 60) * 15));
  return { lat: 38, lon };
}

function hash(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface OrbitParams {
  r: number;
  inc: number;
  node: number;
  speed: number;
  phase: number;
}

/** Each satellite's own tilted orbit, fixed by its id. Frequent tasks fly a little lower and faster. */
function orbitFor(s: SatelliteView): OrbitParams {
  const often = s.cron ? /^(\*|\d+)\s\*\s/.test(s.cron) || s.cron.startsWith("*/") : false;
  const r = (often ? 1.32 : 1.45) + hash(s.id, 1) * 0.45;
  return {
    r,
    inc: (hash(s.id, 2) * 2 - 1) * 68 * D,
    node: hash(s.id, 3) * Math.PI * 2,
    // Slow enough to click: a few pixels a second.
    speed: (0.07 / Math.pow(r, 1.5)) * (hash(s.id, 4) < 0.5 ? 1 : -1),
    phase: hash(s.id, 5) * Math.PI * 2,
  };
}

function orbitPoint(o: OrbitParams, theta: number, out = new Vector3()): Vector3 {
  const x = Math.cos(theta) * o.r;
  const z = Math.sin(theta) * o.r;
  const y1 = -z * Math.sin(o.inc);
  const z1 = z * Math.cos(o.inc);
  return out.set(x * Math.cos(o.node) + z1 * Math.sin(o.node), y1, -x * Math.sin(o.node) + z1 * Math.cos(o.node));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface Sat {
  view: SatelliteView;
  orbit: OrbitParams;
  sprite: Sprite;
  line: LineLoop;
  tex: CanvasTexture;
  accessory: string | null;
  /** 0–1: eases toward 1 while the task runs, so effects fade in and out. */
  level: number;
  pos: Vector3;
  screen: { x: number; y: number; visible: boolean };
  /** Smoothed on-screen heading (unit vector), for the Doppler bunching. */
  heading: { x: number; y: number };
  /** Launch animation start (ms), for satellites created here. */
  launchAt: number | null;
}

interface Ring {
  satId: string;
  t0: number;
  strength: number;
}

type Flight = { kind: "enter" | "leave"; t0: number; dur: number; from: Cam; to: Cam; onFade?: () => void; faded?: boolean; onDone?: () => void };
interface Cam {
  az: number;
  el: number;
  dist: number;
}

const EARTH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vPos;
void main() {
  vUv = uv;
  vPos = position;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// A night Earth: deep ocean with a sun glint, land shaded by procedural terrain,
// polar ice, warm city lights on the dark side, a thin blue atmosphere, and a
// glow on the ground under running satellites.
const EARTH_FRAG = /* glsl */ `
uniform sampler2D uLand;
uniform sampler2D uLights;
uniform vec3 uSun;
uniform vec4 uActive[${ACTIVE_SLOTS}];
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vPos;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec3 n = normalize(vNormal);
  float land = texture2D(uLand, vUv).r;
  float lat = abs(asin(clamp(vPos.y, -1.0, 1.0)));
  float t = fbm(vPos * 5.0);
  float t2 = fbm(vPos * 24.0);
  float arid = smoothstep(0.42, 0.62, t) * (1.0 - smoothstep(0.7, 1.0, lat));
  vec3 ground = mix(vec3(0.09, 0.15, 0.10), vec3(0.34, 0.29, 0.19), arid);
  ground = mix(ground, vec3(0.24, 0.24, 0.22), smoothstep(0.5, 0.8, t2) * 0.55);
  // Where the ice really is: Antarctica, the Greenland ice sheet (not Iceland or
  // Baffin), the high Arctic islands, a little snow on the Himalaya and Tibet.
  // Northern Canada and Siberia stay tundra, not white.
  float latD = degrees(asin(clamp(vPos.y, -1.0, 1.0)));
  float lonD = degrees(atan(-vPos.z, vPos.x));
  float ragged = (t2 - 0.5) * 3.0;
  ground = mix(ground, vec3(0.25, 0.24, 0.2), smoothstep(55.0, 66.0, latD) * 0.8);
  float west = -58.0 - max(latD - 60.0, 0.0) * 0.75;
  float east = mix(-35.0, -15.0, smoothstep(66.0, 72.0, latD));
  float greenland = step(west, lonD) * step(lonD, east) * smoothstep(59.5, 62.0, latD + ragged);
  float antarctica = 1.0 - smoothstep(-63.0, -60.0, latD);
  float arcticIslands = smoothstep(77.0, 81.0, latD + ragged) * 0.9;
  float tibet = smoothstep(26.0, 29.0, latD) * (1.0 - smoothstep(37.0, 40.0, latD)) * smoothstep(72.0, 77.0, lonD) * (1.0 - smoothstep(98.0, 103.0, lonD));
  float landIce = max(max(antarctica, greenland), max(arcticIslands, tibet * smoothstep(0.55, 0.75, t2) * 0.7));
  ground = mix(ground, vec3(0.80, 0.85, 0.89) * (0.9 + 0.1 * t2), landIce);
  vec3 ocean = mix(vec3(0.008, 0.035, 0.075), vec3(0.02, 0.085, 0.15), smoothstep(0.3, 0.7, t));
  // Sea ice: the Arctic pack north of about 75N, and a ragged band off Antarctica.
  float seaIce = max(smoothstep(73.0, 79.0, latD + ragged * 1.5), 1.0 - smoothstep(-69.0, -64.0, latD + ragged));
  ocean = mix(ocean, vec3(0.70, 0.77, 0.82) * (0.92 + 0.08 * t), seaIce);
  vec3 base = mix(ocean, ground, land);
  float ndl = dot(n, uSun);
  float day = smoothstep(-0.18, 0.22, ndl);
  vec3 col = base * (0.035 + 1.3 * max(ndl, 0.0));
  vec3 h = normalize(uSun + vView);
  col += vec3(0.55, 0.66, 0.72) * pow(max(dot(n, h), 0.0), 70.0) * (1.0 - land) * 0.55 * day;
  float lights = texture2D(uLights, vUv).r;
  col += vec3(1.0, 0.64, 0.30) * lights * (1.0 - day) * 2.1;
  float rim = pow(1.0 - max(dot(n, vView), 0.0), 2.6);
  col += vec3(0.22, 0.5, 0.95) * rim * (0.12 + 0.75 * day);
  // Running satellites light the ground below them with a soft pulsing blue.
  vec3 dir = normalize(vPos);
  for (int i = 0; i < ${ACTIVE_SLOTS}; i++) {
    vec4 s = uActive[i];
    if (s.w <= 0.0) continue;
    float d = acos(clamp(dot(dir, s.xyz), -1.0, 1.0));
    float pulse = 0.7 + 0.3 * sin(uTime * 4.0 - d * 24.0);
    col += vec3(0.18, 0.45, 1.0) * exp(-pow(d / 0.22, 2.0)) * s.w * pulse * 0.55;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
uniform float uGain;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float k = pow(max(0.0, 0.62 - dot(normalize(vNormal), vView)), uPower) * uGain;
  gl_FragColor = vec4(uColor * k, k);
}`;

export class OrbitScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.005, 200);
  private readonly ctx: CanvasRenderingContext2D;
  private readonly world = new Group();
  private readonly earthMat: ShaderMaterial;
  /** Coastline textures: loading, loaded, or failed (tried again on the next trip up). */
  private textures: "loading" | "ready" | "failed" = "failed";
  private readonly latticeMat: LineMaterial;
  private readonly lattice: LineSegments2;
  private readonly packetMat: LineMaterial;
  private readonly packets: LineSegments2;
  private readonly halo: Mesh;
  private readonly sats = new Map<string, Sat>();
  private readonly hq: Vector3;
  private readonly sun = new Vector3();
  private cam: Cam;
  private want: Cam;
  private flight: Flight | null = null;
  private rings: Ring[] = [];
  private lastEmit = new Map<string, number>();
  private selected: string | null = null;
  private labels = true;
  private effects: EffectsLevel = "high";
  private theaterName = "";
  private raf = 0;
  private running = false;
  private last = performance.now();
  private width = 1;
  private height = 1;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private overscroll = 0;
  private safe = { left: 0, right: 0, top: 0, bottom: 0 };
  private idleSince = performance.now();
  private readonly ro: ResizeObserver;
  private readonly listeners = new AbortController();
  private readonly accessoryOf: (role: string | null) => string | null;

  constructor(
    private readonly glCanvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly events: OrbitEvents,
    accessoryOf: (role: string | null) => string | null,
  ) {
    this.accessoryOf = accessoryOf;
    this.renderer = new WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(0x03070a);
    this.ctx = overlay.getContext("2d")!;
    const { lat, lon } = hqLatLon();
    this.hq = ll(lat, lon);
    const hqAz = Math.atan2(this.hq.x, this.hq.z);
    this.cam = { az: hqAz, el: lat * D, dist: HOME_MIN };
    this.want = { ...this.cam };

    this.earthMat = new ShaderMaterial({
      uniforms: {
        uLand: { value: blankTexture() },
        uLights: { value: blankTexture() },
        uSun: { value: this.sun },
        uActive: { value: Array.from({ length: ACTIVE_SLOTS }, () => new Vector4()) },
        uTime: { value: 0 },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    });
    // Coastlines arrive a moment later (their data loads on first use).
    this.loadTextures();
    const earth = new Mesh(new SphereGeometry(1, 160, 120), this.earthMat);
    const glow = (r: number, color: number, power: number, gain: number) =>
      new Mesh(
        new SphereGeometry(r, 96, 64),
        new ShaderMaterial({
          uniforms: { uColor: { value: new Color(color) }, uPower: { value: power }, uGain: { value: gain } },
          vertexShader: EARTH_VERT,
          fragmentShader: ATMO_FRAG,
          side: BackSide,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
    const atmo = glow(1.045, 0x4a8fe0, 3.0, 1.2);
    // The network shell: faint amber tracks (mixed inclinations, polar ones too)
    // with cyan packets running along them, and a thin teal rim.
    const lg = new LineSegmentsGeometry();
    lg.setPositions(latticePositions());
    this.latticeMat = new LineMaterial({ color: 0xf3b664, linewidth: 0.8, transparent: true, opacity: 0.2, blending: AdditiveBlending, depthWrite: false });
    this.lattice = new LineSegments2(lg, this.latticeMat);
    this.packetMat = new LineMaterial({ color: 0x73ecf9, linewidth: 1.8, dashed: true, dashSize: 0.05, gapSize: 0.85, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false });
    this.packets = new LineSegments2(lg, this.packetMat);
    this.packets.computeLineDistances();
    this.lattice.add(this.packets);
    this.halo = glow(1.16, 0x4fd4e8, 3.4, 0.0);
    this.world.add(earth, atmo, this.lattice, this.halo);
    this.scene.add(this.world, this.starfield());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(glCanvas);
    this.resize();
    this.bindInput();
    // Compile the shaders now, not on the first frame of the trip up.
    this.placeCamera(this.cam);
    this.renderer.compile(this.scene, this.camera);
  }

  private starfield(): Points {
    const pos: number[] = [];
    let s = 99;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2600; i++) {
      const v = new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(60 + r() * 30);
      pos.push(v.x, v.y, v.z);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    return new Points(g, new PointsMaterial({ color: 0xbfd6de, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }));
  }

  private loadTextures(): void {
    if (this.textures !== "failed") return;
    this.textures = "loading";
    loadEarthTextures().then(
      (t) => {
        this.earthMat.uniforms.uLand!.value = t.land;
        this.earthMat.uniforms.uLights!.value = t.lights;
        this.textures = "ready";
      },
      (err: unknown) => {
        this.textures = "failed";
        console.warn("Orbit view: couldn't load the coastlines", err);
      },
    );
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  setTheater(name: string): void {
    this.theaterName = name;
  }

  setSatellites(list: SatelliteView[]): void {
    const keep = new Set(list.map((s) => s.id));
    for (const [id, sat] of this.sats) {
      if (keep.has(id)) continue;
      this.world.remove(sat.sprite, sat.line);
      sat.tex.dispose();
      (sat.sprite.material as SpriteMaterial).dispose();
      sat.line.geometry.dispose();
      (sat.line.material as LineBasicMaterial).dispose();
      this.sats.delete(id);
    }
    for (const view of list) {
      const existing = this.sats.get(view.id);
      const accessory = view.source === "warroom" ? this.accessoryOf(view.role) : null;
      if (existing) {
        existing.view = view;
        if (existing.accessory !== accessory) {
          existing.tex.dispose();
          existing.tex = satelliteSprite(accessory, view.source === "claude_app" ? "app" : "own");
          (existing.sprite.material as SpriteMaterial).map = existing.tex;
          existing.accessory = accessory;
        }
        continue;
      }
      const orbit = orbitFor(view);
      const tex = satelliteSprite(accessory, view.source === "claude_app" ? "app" : "own");
      const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sprite.scale.set(0.2, 0.12, 1);
      const pts: number[] = [];
      const p = new Vector3();
      for (let i = 0; i < 160; i++) {
        orbitPoint(orbit, (i / 160) * Math.PI * 2, p);
        pts.push(p.x, p.y, p.z);
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(pts, 3));
      const line = new LineLoop(g, new LineBasicMaterial({ color: new Color(view.source === "claude_app" ? 0x8d9aa3 : 0x73ecf9), transparent: true, opacity: 0.18, depthWrite: false }));
      this.world.add(line, sprite);
      this.sats.set(view.id, { view, orbit, sprite, line, tex, accessory, level: view.running ? 1 : 0, pos: new Vector3(), screen: { x: 0, y: 0, visible: false }, heading: { x: 1, y: 0 }, launchAt: null });
    }
  }

  /** Play the launch from HQ for a satellite just created here. */
  launch(id: string): void {
    const sat = this.sats.get(id);
    if (sat) sat.launchAt = performance.now();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.idleSince = performance.now();
  }

  setPrefs(p: { quality: Quality; effects: EffectsLevel; labels: boolean }): void {
    const ratio = { low: 1, medium: Math.min(window.devicePixelRatio, 1.5), high: Math.min(window.devicePixelRatio, 2) }[p.quality];
    if (this.renderer.getPixelRatio() !== ratio) {
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
    this.effects = p.effects;
    this.labels = p.labels;
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  private hqCam(dist: number): Cam {
    return { az: Math.atan2(this.hq.x, this.hq.z), el: Math.asin(this.hq.y), dist };
  }

  /** Pull back from just above HQ to the whole Earth. */
  enter(): void {
    this.start();
    this.loadTextures();
    const from = this.hqCam(1.045);
    const to: Cam = { az: from.az + 0.32, el: from.el * 0.45, dist: this.homeDist() };
    this.cam = { ...from };
    this.want = { ...to };
    this.rings = [];
    this.flight = { kind: "enter", t0: performance.now(), dur: this.effects === "off" ? 900 : 3200, from, to };
  }

  /** Dive back to HQ; `onFade` fires when the city should start to show. */
  leave(onFade: () => void, onDone: () => void): void {
    const to = this.hqCam(1.05);
    // Take the short way round.
    let az = this.cam.az;
    while (az - to.az > Math.PI) az -= Math.PI * 2;
    while (to.az - az > Math.PI) az += Math.PI * 2;
    this.flight = { kind: "leave", t0: performance.now(), dur: this.effects === "off" ? 700 : 1700, from: { ...this.cam, az }, to, onFade, onDone };
  }

  resetCamera(): void {
    const h = this.hqCam(this.homeDist());
    this.want = { az: h.az + 0.32, el: h.el * 0.45, dist: this.homeDist() };
  }

  zoomBy(f: number): void {
    this.want.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.want.dist * f));
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.listeners.abort();
    this.ro.disconnect();
    this.renderer.dispose();
  }

  /** Keep the Earth and its orbits clear of the HUD (screen-edge insets in px); the Earth stays centred. */
  setSafeArea(s: { left: number; right: number; top: number; bottom: number }): void {
    const same = (["left", "right", "top", "bottom"] as const).every((k) => Math.abs(this.safe[k] - s[k]) < 1);
    if (same) return;
    const atHome = !this.flight && Math.abs(this.want.dist - this.homeDist()) < 0.05;
    this.safe = s;
    this.resize();
    if (atHome) this.want.dist = this.homeDist();
  }

  /** Far enough back that the Earth and its orbits, centred on screen, clear the HUD on every side. */
  private homeDist(): number {
    const sideX = Math.max(this.safe.left, this.safe.right);
    const sideY = Math.max(this.safe.top, this.safe.bottom);
    const free = Math.max(160, Math.min(this.width - 2 * sideX, this.height - 2 * sideY));
    return Math.min(MAX_DIST, Math.max(HOME_MIN, (1.8 * this.height) / (Math.tan((FOV / 2) * D) * free)));
  }

  private resize(): void {
    const w = this.glCanvas.clientWidth || 1;
    const h = this.glCanvas.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.latticeMat.resolution.set(w, h);
    this.packetMat.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private placeCamera(c: Cam): void {
    const ce = Math.cos(c.el);
    this.camera.position.set(Math.sin(c.az) * ce * c.dist, Math.sin(c.el) * c.dist, Math.cos(c.az) * ce * c.dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
  }

  private readonly tmp = new Vector3();

  private project(p: Vector3): { x: number; y: number; visible: boolean } {
    const v = this.tmp.copy(p).project(this.camera);
    const camPos = this.camera.position;
    // Behind the globe?
    const d = p.clone().sub(camPos);
    const len = d.length();
    d.divideScalar(len);
    const b = camPos.dot(d);
    const c = camPos.lengthSq() - 1;
    const disc = b * b - c;
    let hidden = false;
    if (disc > 0) {
      const t0 = -b - Math.sqrt(disc);
      hidden = t0 > 0 && t0 < len - 1e-4;
    }
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, visible: v.z < 1 && !hidden };
  }

  /** Pixels per world unit at the origin's depth. */
  private pxPerUnit(): number {
    return this.height / (2 * this.camera.position.length() * Math.tan((FOV / 2) * D));
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;

    // Camera: a scripted flight, or ease toward what the controls want.
    const f = this.flight;
    if (f) {
      const u = clamp01((now - f.t0) / f.dur);
      const e = ease(u);
      this.cam = {
        az: f.from.az + (f.to.az - f.from.az) * e,
        el: f.from.el + (f.to.el - f.from.el) * e,
        dist: Math.exp(Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * (f.kind === "enter" ? e : u * u)),
      };
      if (f.kind === "leave" && !f.faded && u > 0.55) {
        f.faded = true;
        f.onFade?.();
      }
      if (u >= 1) {
        this.flight = null;
        this.want = { ...this.cam };
        f.onDone?.();
        if (f.kind === "leave") {
          this.stop();
          return;
        }
      }
    } else {
      // Drift slowly when nobody is steering; follow the selected satellite.
      const sel = this.selected ? this.sats.get(this.selected) : null;
      if (sel && !this.drag) {
        const p = sel.pos;
        const az = Math.atan2(p.x, p.z) - 0.42; // keep it left of the side panel
        let d = az - this.want.az;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.want.az += d * Math.min(1, dt * 1.6);
        this.want.el += (Math.max(-1, Math.min(1, Math.asin(p.y / p.length()) * 0.7)) - this.want.el) * Math.min(1, dt * 1.2);
      } else if (!this.drag && now - this.idleSince > 4000) {
        this.want.az += dt * 0.02;
      }
      const k = 1 - Math.exp(-dt * 6);
      this.cam.az += (this.want.az - this.cam.az) * k;
      this.cam.el += (this.want.el - this.cam.el) * k;
      this.cam.dist += (this.want.dist - this.cam.dist) * k;
    }
    this.placeCamera(this.cam);
    this.camera.updateMatrixWorld();

    // Sun from the viewer's upper left: a lit side and a night side with city lights.
    this.sun.set(-0.62, 0.38, 0.55).applyQuaternion(this.camera.quaternion).normalize();
    this.earthMat.uniforms.uTime!.value = t;

    // Satellites.
    const appear = this.flight?.kind === "enter" ? clamp01(((now - this.flight.t0) / this.flight.dur - 0.55) / 0.35) : this.flight?.kind === "leave" ? 1 - clamp01((now - this.flight.t0) / this.flight.dur / 0.4) : 1;
    const active: Vector4[] = this.earthMat.uniforms.uActive!.value;
    for (const a of active) a.set(0, 0, 0, 0);
    let slot = 0;
    for (const sat of this.sats.values()) {
      const target = sat.view.running ? 1 : 0;
      sat.level += (target - sat.level) * Math.min(1, dt * (target ? 1.6 : 0.9));
      if (Math.abs(target - sat.level) < 0.002) sat.level = target;
      const theta = sat.orbit.phase + sat.orbit.speed * t;
      orbitPoint(sat.orbit, theta, sat.pos);
      let fly = 1;
      if (sat.launchAt !== null) {
        // Climb from HQ to the orbit, then settle into it.
        fly = clamp01((now - sat.launchAt) / 2400);
        const k = 1 - Math.pow(1 - fly, 3);
        const dir = this.hq.clone().lerp(sat.pos.clone().normalize(), k).normalize();
        sat.pos.copy(dir.multiplyScalar(1 + (sat.orbit.r - 1) * k));
        if (fly >= 1) sat.launchAt = null;
      }
      sat.sprite.position.copy(sat.pos);
      const sel = sat.view.id === this.selected;
      const s = (sel ? 1.25 : 1) * (sat.launchAt !== null ? 0.4 + 0.6 * fly : 1);
      sat.sprite.scale.set(0.2 * s, 0.12 * s, 1);
      const m = sat.sprite.material as SpriteMaterial;
      m.opacity = appear * (sat.view.enabled ? 1 : 0.45) * (sat.view.source === "claude_app" ? 0.8 : 1);
      const lm = sat.line.material as LineBasicMaterial;
      lm.opacity = appear * (sel ? 0.55 : 0.14 + 0.25 * sat.level) * (sat.launchAt !== null ? fly : 1);
      lm.color.set(sat.level > 0.05 ? 0x4aa8ff : sat.view.source === "claude_app" ? 0x8d9aa3 : 0x73ecf9);
      const prev = sat.screen;
      sat.screen = this.project(sat.pos);
      const dx = sat.screen.x - prev.x;
      const dy = sat.screen.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.01 && len < 40) {
        const k = Math.min(1, dt * 3);
        const hx = sat.heading.x + (dx / len - sat.heading.x) * k;
        const hy = sat.heading.y + (dy / len - sat.heading.y) * k;
        const hl = Math.hypot(hx, hy) || 1;
        sat.heading = { x: hx / hl, y: hy / hl };
      }
      if (sat.level > 0.01 && slot < ACTIVE_SLOTS && this.effects !== "off") {
        const n = sat.pos.clone().normalize();
        active[slot++]!.set(n.x, n.y, n.z, sat.level);
      }
    }

    this.latticeMat.opacity = 0.2 * appear;
    this.packetMat.opacity = (this.effects === "off" ? 0 : 0.85) * appear;
    this.packetMat.dashOffset = -t * 0.18;
    this.lattice.rotation.y = t * 0.01;
    (this.halo.material as ShaderMaterial).uniforms.uGain!.value = 0.22 * appear;
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay(now, appear);
  };

  // ── HUD overlay ───────────────────────────────────────────────────────────

  private drawOverlay(now: number, appear: number): void {
    const c = this.ctx;
    const t = now / 1000;
    c.clearRect(0, 0, this.width, this.height);
    const ppu = this.pxPerUnit();
    const visible = [...this.sats.values()].filter((s) => s.screen.visible);
    const fx = this.effects !== "off";

    // Quiet mesh: each satellite linked to its nearest neighbour.
    if (appear > 0 && fx) {
      c.save();
      c.setLineDash([2, 5]);
      c.lineWidth = 1;
      c.strokeStyle = `rgba(${BLUE},${0.13 * appear})`;
      for (const s of visible) {
        const n = this.nearest(s, visible, 1)[0];
        if (!n) continue;
        c.beginPath();
        c.moveTo(s.screen.x, s.screen.y);
        c.lineTo(n.screen.x, n.screen.y);
        c.stroke();
      }
      c.restore();
    }

    // Running tasks: Doppler rings and live links. The rings ride with the
    // satellite; each one's centre slides back as it grows, so they bunch up
    // on the side it's heading and spread out behind.
    const ringLife = 1.7;
    this.rings = this.rings.filter((r) => t - r.t0 < ringLife && t >= r.t0);
    for (const s of this.sats.values()) {
      if (s.level < 0.15 || !s.screen.visible || !fx) continue;
      const last = this.lastEmit.get(s.view.id) ?? 0;
      if (t - last > 0.34) {
        this.rings.push({ satId: s.view.id, t0: t, strength: s.level });
        this.lastEmit.set(s.view.id, t);
      }
    }
    c.lineWidth = 1.4;
    for (const r of this.rings) {
      const s = this.sats.get(r.satId);
      if (!s || !s.screen.visible) continue;
      const a = (t - r.t0) / ringLife;
      const radius = 4 + a * ppu * 0.5;
      const back = radius * 0.35;
      c.strokeStyle = `rgba(${BLUE},${0.7 * (1 - a) * r.strength * appear})`;
      c.beginPath();
      c.arc(s.screen.x - s.heading.x * back, s.screen.y - s.heading.y * back, radius, 0, Math.PI * 2);
      c.stroke();
    }
    for (const s of visible) {
      if (s.level < 0.01 || !fx) continue;
      this.nearest(s, visible, 3).forEach((n, i) => {
        c.strokeStyle = `rgba(${BLUE},${0.55 * s.level * appear})`;
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(s.screen.x, s.screen.y);
        c.lineTo(n.screen.x, n.screen.y);
        c.stroke();
        c.save();
        c.shadowColor = `rgba(${BLUE},1)`;
        c.shadowBlur = 6;
        c.fillStyle = `rgba(200,232,255,${s.level * appear})`;
        for (let k = 0; k < 3; k++) {
          const f = (t * 0.8 + k / 3 + i * 0.17) % 1;
          c.fillRect(s.screen.x + (n.screen.x - s.screen.x) * f - 1.5, s.screen.y + (n.screen.y - s.screen.y) * f - 1.5, 3, 3);
        }
        c.restore();
        const pulse = (t * 1.6 + i * 0.3) % 1;
        c.strokeStyle = `rgba(${BLUE},${0.55 * (1 - pulse) * s.level * appear})`;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(n.screen.x, n.screen.y, 5 + pulse * 10, 0, Math.PI * 2);
        c.stroke();
      });
    }

    // Launch streaks.
    for (const s of this.sats.values()) {
      if (s.launchAt === null) continue;
      const hq = this.project(this.hq);
      c.strokeStyle = `rgba(${ORANGE},0.85)`;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(hq.x, hq.y);
      c.lineTo(s.screen.x, s.screen.y);
      c.stroke();
    }

    // HQ marker.
    const hq = this.project(this.hq.clone().multiplyScalar(1.002));
    if (hq.visible && this.flight?.kind !== "leave") {
      const k = (t % 1.6) / 1.6;
      const a = this.flight?.kind === "enter" ? clamp01(((now - this.flight.t0) / this.flight.dur - 0.35) / 0.3) : 1;
      c.strokeStyle = `rgba(${ORANGE},${0.7 * (1 - k) * a})`;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(hq.x, hq.y, 3 + k * 12, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = `rgba(${ORANGE},${a})`;
      c.fillRect(hq.x - 3, hq.y - 3, 6, 6);
      this.text(`HQ · ${this.theaterName}`, hq.x + 10, hq.y + 4, `rgba(${ORANGE},${0.95 * a})`, 11);
    }

    // Labels and the selection bracket. The selected and running ones claim space first;
    // a quiet label that would overlap another is left out.
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const rank = (s: Sat) => (s.view.id === this.selected ? 0 : s.view.running ? 1 : 2);
    c.font = `700 12px Rajdhani, "Arial Narrow", sans-serif`;
    for (const s of [...visible].sort((a, b) => rank(a) - rank(b))) {
      const sel = s.view.id === this.selected;
      if (sel) {
        c.strokeStyle = `rgba(${s.level > 0.05 ? BLUE : CYAN},0.95)`;
        c.lineWidth = 1.5;
        const r = 16;
        c.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const x = s.screen.x + sx * r;
          const y = s.screen.y + sy * r;
          c.moveTo(x, y - sy * 6);
          c.lineTo(x, y);
          c.lineTo(x - sx * 6, y);
        }
        c.stroke();
      }
      if (!this.labels && !sel) continue;
      const running = s.level > 0.05 && s.view.running;
      const tone = running ? BLUE : s.view.source === "claude_app" ? "170,182,190" : "232,237,239";
      const left = s.screen.x > this.width * 0.7;
      const x = s.screen.x + (left ? -16 : 16);
      const sub = running ? (s.view.activity ?? "Running") : s.view.source === "claude_app" ? `Claude app · ${s.view.scheduleText}` : s.view.enabled ? s.view.scheduleText : "Paused";
      const w = Math.min(260, Math.max(c.measureText(s.view.name.toUpperCase()).width * 1.12, sub.length * 6.2));
      const box = { x0: left ? x - w : x, x1: left ? x : x + w, y0: s.screen.y - 16, y1: s.screen.y + 13 };
      if (rank(s) === 2 && placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
      placed.push(box);
      this.text(s.view.name, x, s.screen.y - 4, `rgba(${tone},${0.95 * appear})`, 12, left ? "right" : "left");
      this.text(sub, x, s.screen.y + 9, `rgba(232,237,239,${0.55 * appear})`, 10, left ? "right" : "left");
    }
  }

  private nearest(s: Sat, among: Sat[], k: number): Sat[] {
    return among
      .filter((o) => o !== s)
      .map((o) => [o, o.pos.distanceToSquared(s.pos)] as const)
      .sort((a, b) => a[1] - b[1])
      .slice(0, k)
      .map((a) => a[0]);
  }

  private text(s: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = "left"): void {
    const c = this.ctx;
    c.font = `700 ${size}px Rajdhani, "Arial Narrow", sans-serif`;
    if ("letterSpacing" in c) (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "1.2px";
    c.textAlign = align;
    c.fillStyle = color;
    c.fillText((s.length > 46 ? `${s.slice(0, 45)}…` : s).toUpperCase(), x, y);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private pick(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = 26 * 26;
    for (const s of this.sats.values()) {
      if (!s.screen.visible) continue;
      const d = (s.screen.x - x) ** 2 + (s.screen.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s.view.id;
      }
    }
    return best;
  }

  private bindInput(): void {
    const el = this.overlay;
    const signal = this.listeners.signal;
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.flight) return;
        this.idleSince = performance.now();
        const f = Math.exp(e.deltaY * 0.0012);
        // Scrolling in past the closest view lands back in the city.
        if (f < 1 && this.want.dist <= MIN_DIST + 1e-3) {
          this.overscroll += -Math.log(f);
          if (this.overscroll > 0.45) {
            this.overscroll = 0;
            this.events.onWantCity();
          }
          return;
        }
        this.overscroll = 0;
        this.zoomBy(f);
      },
      { passive: false, signal },
    );
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        el.setPointerCapture(e.pointerId);
        this.drag = { x: e.clientX, y: e.clientY, moved: false };
      },
      { signal },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        const rect = el.getBoundingClientRect();
        if (this.drag) {
          const dx = e.clientX - this.drag.x;
          const dy = e.clientY - this.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
          if (this.drag.moved && !this.flight) {
            const k = 0.0042 * (this.cam.dist / this.homeDist());
            this.want.az -= dx * k;
            this.want.el = Math.max(-1.25, Math.min(1.25, this.want.el + dy * k));
            this.drag.x = e.clientX;
            this.drag.y = e.clientY;
            this.idleSince = performance.now();
            el.style.cursor = "grabbing";
          }
          return;
        }
        el.style.cursor = this.pick(e.clientX - rect.left, e.clientY - rect.top) ? "pointer" : "default";
      },
      { signal },
    );
    el.addEventListener(
      "pointerup",
      (e) => {
        const d = this.drag;
        this.drag = null;
        el.style.cursor = "default";
        if (!d || d.moved || this.flight) return;
        const rect = el.getBoundingClientRect();
        this.events.onPick(this.pick(e.clientX - rect.left, e.clientY - rect.top));
      },
      { signal },
    );
  }

  /** Where a satellite is on screen (for HUD panels that point at it). */
  screenOf(id: string): { x: number; y: number; visible: boolean } | null {
    return this.sats.get(id)?.screen ?? null;
  }
}
