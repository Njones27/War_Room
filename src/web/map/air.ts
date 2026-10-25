// The air wing over the Code City: Black Hawks that airlift agents to their
// work, a pair of F-35s that fly strike missions from an airbase outside the
// map, a UAV on station very high up, and an AC-130 gunship. The gunship
// works over whatever the agents are working on with its three guns, and when
// a file is deleted it brings that building down.
//
// Nothing flies through anything: every aircraft holds height above the
// buildings near it and along its path, and each frame converging aircraft
// are separated by height.
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NotEqualStencilFunc,
  PlaneGeometry,
  ReplaceStencilOp,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { CityModel } from "../../shared/city";
import { buildAircraft, type Aircraft, type AircraftKind } from "./aircraft";
import { type Airfield, airfieldFor } from "./airfield";
import { Fighter } from "./fighter";
import { clamp, type Flyer, headingOf, reach, restHeight, separate, underside, wrap } from "./flight";
import type { EffectsLevel } from "../lib/prefs";
import { Fx } from "./fx";
import { GUNS, GunStation, Tracers, type GunKind, type GunSpec } from "./guns";
import { Ordnance } from "./ordnance";
import { HeightField } from "./terrain";

export interface Spot {
  x: number;
  z: number;
  /** Height the agent stands at (a building's roof, else ~0.4). */
  top: number;
}

export interface LiftState extends Spot {
  /** queued → boarding → riding → done (or abandoned when no helicopter came). */
  phase: "queued" | "boarding" | "riding" | "done" | "abandoned";
  /** Walking to the helicopter on the pad. */
  walking: boolean;
  embarked: boolean;
}

export interface StrikeTarget {
  path: string;
  x: number;
  z: number;
  w: number;
  h: number;
  height: number;
}

const SHADOW_Y = 0.42;
const WALK = 42; // matches the map's walking speed
/** Minimum on-screen length in CSS pixels, so aircraft read like BF6 icons at any zoom. */
const MIN_PX: Record<AircraftKind, number> = { blackhawk: 34, lightning: 34, uav: 30, gunship: 50 };
/** Heights above the tallest rooftop, per aircraft (× map scale). The UAV sits far above everything. */
const LAYER = { helo: 8, gunship: 48, uav: 110 };

interface Lift {
  id: string;
  from: Spot;
  to: Spot;
  phase: LiftState["phase"];
  helo: Helo | null;
  agent: Vector3;
  walking: boolean;
  embarked: boolean;
  /** At the pad: the agent walks out to the parked helicopter instead of being picked up. */
  walkOn: boolean;
  timer: number;
  waited: number;
}

interface Helo extends Flyer {
  home: Vector3;
  /** The height it's holding this frame, after rooftops and separation. */
  holdY: number;
  vel: Vector3;
  job: Lift | null;
  /** Where it's flying; `land` puts it down there, otherwise it hovers at `y`. */
  goal: { x: number; z: number; y: number; land: boolean } | null;
  grounded: boolean;
  idle: number;
}

interface Orbiter extends Flyer {
  center: Vector3;
  want: Vector3;
  rx: number;
  rz: number;
  wantR: number;
  /** Current radius multiplier (shrinks for a pylon turn over a strike). */
  r: number;
  angle: number;
  speed: number;
  /** +1 clockwise (right turn), -1 counter-clockwise (left turn, the gunship's). */
  dir: 1 | -1;
}

interface Shot {
  at: number;
  target: StrikeTarget;
  gun: GunKind;
  onHit?: () => void;
}

/** The gunship's guns fire from its port side, front to back: 25mm, 40mm, 105mm (model units). */
const GUN_PORTS: Record<"gau12" | "bofors" | "m102", Vector3> = {
  gau12: new Vector3(0.12, 0, -0.1),
  bofors: new Vector3(-0.04, 0, -0.1),
  m102: new Vector3(-0.14, 0, -0.1),
};

function runwayTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#39444c";
  g.fillRect(0, 0, 1024, 96);
  g.fillStyle = "rgba(230,236,238,0.85)";
  for (let x = 120; x < 904; x += 56) g.fillRect(x, 45, 30, 6);
  for (const x0 of [14, 1010 - 74]) for (let i = 0; i < 6; i++) g.fillRect(x0, 10 + i * 13, 60, 7);
  g.fillRect(0, 2, 1024, 3);
  g.fillRect(0, 91, 1024, 3);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function padTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a454d";
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(230,236,238,0.85)";
  g.lineWidth = 5;
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "rgba(230,236,238,0.9)";
  g.fillRect(44, 36, 10, 56);
  g.fillRect(74, 36, 10, 56);
  g.fillRect(44, 59, 40, 10);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** The air traffic control tower: a shaft, a glass cab, and a radar turning on the roof. */
function controlTower(height: number): { tower: Group; radar: Mesh; beacon: Mesh } {
  const tower = new Group();
  const concrete = new MeshLambertMaterial({ color: 0x7c8a94, flatShading: true });
  const trim = new MeshLambertMaterial({ color: 0x9cc9dc, emissive: 0x163c4a, flatShading: true });
  const glass = new MeshLambertMaterial({ color: 0x1b2b34, emissive: 0x0d2a33, flatShading: true });
  const part = (geo: BoxGeometry | CylinderGeometry, mat: MeshLambertMaterial, y: number) => {
    const m = new Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    tower.add(m);
    return m;
  };
  const shaft = height - 5;
  part(new BoxGeometry(6, 2.4, 6), concrete, 1.2);
  part(new CylinderGeometry(1.3, 1.6, shaft, 8), concrete, shaft / 2);
  part(new CylinderGeometry(3.1, 2.4, 0.8, 8), trim, shaft + 0.4);
  part(new CylinderGeometry(3.2, 3.0, 2.6, 8), glass, shaft + 2.1);
  part(new CylinderGeometry(3.5, 3.5, 0.6, 8), trim, shaft + 3.7);
  part(new CylinderGeometry(0.25, 0.25, 1.4, 6), concrete, shaft + 4.6);
  const radar = new Mesh(new BoxGeometry(3.2, 0.5, 0.35), trim);
  radar.position.y = shaft + 5.3;
  radar.castShadow = true;
  tower.add(radar);
  const beacon = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicMaterial({ color: 0xff4a3a }));
  beacon.position.y = shaft + 5.7;
  tower.add(beacon);
  return { tower, radar, beacon };
}

/** How long a called strike's round waits for its target to come round off the left wing. */
const ARC_WAIT = 4;

export class AirWing {
  readonly group = new Group();
  readonly fx = new Fx();
  private readonly base = new Group();
  private readonly fleet = new Group();
  private readonly shadowGroup = new Group();
  private readonly shadowMat = new MeshBasicMaterial({
    color: 0x05080a,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: NotEqualStencilFunc,
    stencilZPass: ReplaceStencilOp,
  });
  private shadows: { caster: Mesh; shadow: Mesh; ac: Aircraft }[] = [];
  private readonly project = new Matrix4();
  private city: CityModel | null = null;
  private field: Airfield | null = null;
  private heights: HeightField | null = null;
  private radar: Mesh | null = null;
  private towerBeacon: Mesh | null = null;
  private helos: Helo[] = [];
  private jets: Fighter[] = [];
  private uav: Orbiter | null = null;
  private gunship: Orbiter | null = null;
  private lifts = new Map<string, Lift>();
  private shots: Shot[] = [];
  private strikeCooldown = 0;
  /** Rounds in flight. */
  readonly tracers = new Tracers();
  /** Bombs and missiles in flight. */
  readonly ordnance = new Ordnance(this.fx);
  /** The gunship's gun stations and what each is shooting at. */
  private readonly stations = (["gau12", "bofors", "m102"] as const).map((kind, i) => ({ kind, gun: new GunStation(GUNS[kind], 1.5 + i * 2.2), target: null as StrikeTarget | null }));
  /** Buildings agents are working on: the gunship's targets. */
  private targets: StrikeTarget[] = [];
  /** Buildings coming down or down: nobody attacks them any more. */
  private down = new Set<string>();
  private time = 0;
  /** The effects setting: high keeps the gunship and F-35s working over targets; medium, the gunship at half rate; low and off, only called strikes. */
  private effects: EffectsLevel = "high";
  /** Off: aircraft are hidden, nothing flies lifts, and strikes are handled by the map. */
  private vehicles = true;
  /** World scale: 1 for a ~320-unit map. */
  private k = 1;
  private readonly tmpPos = new Vector3();
  private readonly tmpDir = new Vector3();

  constructor() {
    this.group.add(this.base, this.shadowGroup, this.fleet, this.fx.group, this.tracers.mesh, this.ordnance.group);
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  /** `sun` points the way the sunlight travels (down toward the ground). */
  setCity(city: CityModel, sun: Vector3): void {
    const first = this.city === null;
    this.city = city;
    const b = city.bounds;
    this.k = Math.max(1, Math.max(b.w, b.h) / 320);
    this.fx.setScale(this.k);
    this.fx.clear();
    this.tracers.setScale(this.k);
    this.tracers.clear();
    this.ordnance.setScale(this.k);
    this.ordnance.clear();
    this.shots = [];
    this.targets = [];
    this.down.clear();
    this.project.set(1, -sun.x / sun.y, 0, (sun.x / sun.y) * SHADOW_Y, 0, 0, 0, SHADOW_Y, 0, -sun.z / sun.y, 1, (sun.z / sun.y) * SHADOW_Y, 0, 0, 0, 1);
    this.field = airfieldFor(city);
    const t = this.field.tower;
    this.heights = new HeightField(city, [{ x: t.x - 4, z: t.z - 4, w: 8, h: 8, top: t.height + 1 }]);
    this.buildBase(this.field);
    if (first) this.spawnFleet();
    this.rehome();
  }

  private buildBase(f: Airfield): void {
    // Free the old airbase's GPU resources (textures included) before building the new one.
    this.base.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        (mat as MeshLambertMaterial).map?.dispose();
        mat.dispose();
      }
    });
    for (const c of [...this.base.children]) this.base.remove(c);
    const flat = (w: number, h: number, mat: MeshLambertMaterial, x: number, z: number, y: number) => {
      const m = new Mesh(new PlaneGeometry(w, h), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.receiveShadow = true;
      this.base.add(m);
      return m;
    };
    // The airbase's own ground, outside the playable boundary.
    const b = f.base;
    flat(b.w, b.h, new MeshLambertMaterial({ color: 0x222c32 }), b.x + b.w / 2, b.y + b.h / 2, 0.03);
    const r = f.runway;
    flat(r.x1 - r.x0, r.width, new MeshLambertMaterial({ map: runwayTexture() }), (r.x0 + r.x1) / 2, r.z, 0.08);
    flat(f.apron.w, f.apron.h, new MeshLambertMaterial({ color: 0x35414a }), f.apron.x + f.apron.w / 2, f.apron.y + f.apron.h / 2, 0.07);
    const padMat = new MeshLambertMaterial({ map: padTexture(), transparent: true });
    for (const [x, z] of f.pads) flat(11, 11, padMat, x, z, 0.09);
    const { tower, radar, beacon } = controlTower(f.tower.height);
    tower.position.set(f.tower.x, 0, f.tower.z);
    this.base.add(tower);
    this.radar = radar;
    this.towerBeacon = beacon;
  }

  private flyer(kind: AircraftKind): Flyer {
    const ac = buildAircraft(kind);
    this.fleet.add(ac.root);
    const f: Flyer = { ac, pos: new Vector3(), heading: 0, pitch: 0, bank: 0, spool: 0, scale: 1, fade: 1, motion: new Vector3(), minY: -Infinity, maxY: Infinity };
    for (const caster of ac.casters) {
      const shadow = new Mesh(caster.geometry, this.shadowMat);
      shadow.matrixAutoUpdate = false;
      shadow.frustumCulled = false;
      this.shadowGroup.add(shadow);
      this.shadows.push({ caster, shadow, ac });
    }
    return f;
  }

  private spawnFleet(): void {
    for (let i = 0; i < 3; i++) {
      const f = this.flyer("blackhawk");
      this.helos.push({ ...f, home: new Vector3(), holdY: 0, vel: new Vector3(), job: null, goal: null, grounded: true, idle: 99 });
    }
    for (let i = 0; i < 2; i++) {
      this.jets.push(
        new Fighter(this.flyer("lightning"), i, {
          field: () => this.field!,
          city: () => this.city!,
          heights: () => this.heights!,
          k: () => this.k,
          // Attack passes are ambient fire: only at the highest effects setting.
          targets: () => (this.vehicles && this.effects === "high" ? this.targets : []),
          standing: (path) => !this.down.has(path),
          // Taking off waits for anyone departing or on the way in; committing to final waits for anyone departing or landing.
          runwayBusy: (self, depart) => this.jets.some((j) => j !== self && (depart ? j.runwayUse() !== "none" : ["departing", "landing"].includes(j.runwayUse()))),
          tracers: this.tracers,
          ordnance: this.ordnance,
          fx: this.fx,
        }),
      );
    }
    const orbiter = (kind: AircraftKind, dir: 1 | -1, speed: number): Orbiter => ({
      ...this.flyer(kind),
      center: new Vector3(),
      want: new Vector3(),
      rx: 1,
      rz: 1,
      wantR: 1,
      r: 1,
      angle: Math.random() * Math.PI * 2,
      speed,
      dir,
      spool: 1,
    });
    // A slow, high loiter for the UAV; the gunship orbits lower and faster.
    this.uav = orbiter("uav", 1, 11);
    this.gunship = orbiter("gunship", -1, 32);
  }

  /** Put everything back on its stations for a (re)built city. */
  private rehome(): void {
    const city = this.city!;
    const f = this.field!;
    const b = city.bounds;
    const k = this.k;
    const top = this.heights!.top;
    this.helos.forEach((h, i) => {
      const [x, z] = f.pads[i % f.pads.length]!;
      h.home.set(x, restHeight(h), z);
      if (!h.job && h.grounded) {
        h.pos.copy(h.home);
        h.heading = Math.PI / 2;
        h.goal = null;
      }
    });
    this.jets.forEach((j, i) => {
      const [x, z] = f.stands[i % f.stands.length]!;
      j.setStand(x, z);
    });
    // Both orbit far out. The UAV is so high its circle looks wider on screen, so it flies a tighter one.
    const c = new Vector3(b.x + b.w / 2, 0, b.y + b.h / 2);
    for (const [o, frac, alt] of [
      [this.uav!, 0.36, top + LAYER.uav * k],
      [this.gunship!, 0.56, top + LAYER.gunship * k],
    ] as const) {
      o.center.set(c.x, alt, c.z);
      o.want.copy(o.center);
      o.rx = b.w * frac;
      o.rz = b.h * frac;
    }
  }

  // ── Airlift ───────────────────────────────────────────────────────────────

  /** Fly an agent from where it stands to its new post. */
  requestLift(id: string, from: Spot, to: Spot): void {
    const existing = this.lifts.get(id);
    if (existing && existing.phase !== "done" && existing.phase !== "abandoned") {
      this.retarget(id, to);
      return;
    }
    this.lifts.set(id, {
      id,
      from: { ...from },
      to: { ...to },
      phase: "queued",
      helo: null,
      agent: new Vector3(from.x, from.top, from.z),
      walking: false,
      embarked: false,
      walkOn: false,
      timer: 0,
      waited: 0,
    });
  }

  /**
   * The agent's post moved while it waits or rides. Aboard, only a move to
   * another part of the city reroutes the helicopter; nearby, the agent walks
   * the rest after the drop. Once the rope is down the drop zone is fixed.
   */
  retarget(id: string, to: Spot): void {
    const l = this.lifts.get(id);
    if (!l || l.phase === "done" || l.phase === "abandoned") return;
    if (l.phase === "riding" && (!l.embarked || Math.hypot(to.x - l.to.x, to.z - l.to.z) < 30 * this.k)) return;
    l.to = { ...to };
  }

  /** Where the agent is during its lift. */
  liftState(id: string): LiftState | null {
    const l = this.lifts.get(id);
    if (!l) return null;
    return { x: l.agent.x, z: l.agent.z, top: l.agent.y, phase: l.phase, walking: l.walking, embarked: l.embarked };
  }

  /** Forget a finished lift (or drop one for an agent that left the map). */
  endLift(id: string): void {
    const l = this.lifts.get(id);
    if (!l) return;
    if (l.helo && l.helo.job === l) this.release(l.helo);
    this.lifts.delete(id);
  }

  /** Whether the agent at this spot is close enough to HQ to board at the pads. */
  private nearPads(s: Spot): boolean {
    const hq = this.city?.hq.rect;
    return !!hq && s.x > hq.x - 12 && s.x < hq.x + hq.w + 12 && s.z > hq.y - 12 && s.z < hq.y + hq.h + 30;
  }

  private release(h: Helo): void {
    h.job = null;
    const next = [...this.lifts.values()].find((l) => l.phase === "queued");
    if (next) this.assign(next, h);
    else h.goal = { x: h.home.x, z: h.home.z, y: h.home.y, land: true };
  }

  private assign(l: Lift, h: Helo): void {
    l.helo = h;
    h.job = l;
    l.walkOn = h.grounded && Math.hypot(h.pos.x - h.home.x, h.pos.z - h.home.z) < 1 && this.nearPads(l.from);
    l.phase = "boarding";
    l.timer = 0;
    if (l.walkOn) h.goal = null;
    else h.goal = { x: l.from.x, z: l.from.z, y: this.hoverOver(l.from, h), land: false };
  }

  /** Hover height over a spot: clear of the roof below and of anything the rotor could touch. */
  private hoverOver(s: Spot, h: Helo): number {
    const clear = this.heights!.at(s.x, s.z, reach(h) * 0.8);
    return Math.max(Math.max(s.top, 0.4) + 3 * this.k + restHeight(h), clear > 0 ? clear + underside(h, 0.45) + 2 * this.k : 0);
  }

  private updateLifts(dt: number): void {
    for (const l of this.lifts.values()) {
      if (l.phase === "queued") {
        l.waited += dt;
        const free = this.helos.filter((h) => !h.job).sort((a, b) => a.pos.distanceTo(l.agent) - b.pos.distanceTo(l.agent))[0];
        if (free) this.assign(l, free);
        else if (l.waited > 6) l.phase = "abandoned";
        continue;
      }
      const h = l.helo;
      if (!h) continue;
      if (l.phase === "boarding") {
        if (l.walkOn) {
          // Walk out to the door and climb aboard while the rotors spool up.
          const side = h.heading + Math.PI / 2;
          const door = this.tmpPos.set(h.pos.x + Math.cos(side) * 0.12 * h.ac.length * h.scale, 0.4, h.pos.z - Math.sin(side) * 0.12 * h.ac.length * h.scale);
          const d = Math.hypot(door.x - l.agent.x, door.z - l.agent.z);
          l.walking = d > 0.4;
          if (l.walking) {
            const step = Math.min(d, WALK * dt);
            l.agent.x += ((door.x - l.agent.x) / d) * step;
            l.agent.z += ((door.z - l.agent.z) / d) * step;
            l.agent.y = 0.4;
          } else {
            l.timer += dt;
            if (l.timer > 0.35) this.embark(l, h);
          }
        } else if (this.arrived(h)) {
          // Hoist up from the roof or street.
          l.timer += dt;
          const k = Math.min(1, l.timer / 0.9);
          l.agent.set(h.pos.x, l.from.top + (h.pos.y - 2 - l.from.top) * k, h.pos.z);
          if (k >= 1) this.embark(l, h);
        }
        continue;
      }
      if (l.phase === "riding") {
        const y = this.hoverOver(l.to, h);
        if (!h.goal || h.goal.x !== l.to.x || h.goal.z !== l.to.z) h.goal = { x: l.to.x, z: l.to.z, y, land: false };
        h.goal.y = y;
        if (l.embarked) l.agent.set(h.pos.x, h.pos.y - 1.5, h.pos.z);
        if (this.arrived(h)) {
          // Fast-rope down onto the objective.
          l.embarked = false;
          l.timer += dt;
          const k = Math.min(1, l.timer / 0.9);
          l.agent.set(h.pos.x + (l.to.x - h.pos.x) * k, h.pos.y - 2 + (l.to.top - (h.pos.y - 2)) * k, h.pos.z + (l.to.z - h.pos.z) * k);
          if (k >= 1) {
            l.phase = "done";
            l.helo = null;
            this.release(h);
          }
        }
      }
    }
  }

  private embark(l: Lift, h: Helo): void {
    l.phase = "riding";
    l.embarked = true;
    l.walking = false;
    l.timer = 0;
    h.goal = { x: l.to.x, z: l.to.z, y: this.hoverOver(l.to, h), land: false };
  }

  private arrived(h: Helo): boolean {
    const g = h.goal;
    if (!g) return h.grounded;
    return Math.hypot(g.x - h.pos.x, g.z - h.pos.z) < 0.8 && Math.abs(Math.max(g.y, h.holdY) - h.pos.y) < 0.6 && h.vel.length() < 2;
  }

  private flyHelo(h: Helo, dt: number): void {
    const k = this.k;
    const wantSpool = h.job || h.goal ? 1 : h.idle > 2.5 ? 0 : 1;
    h.spool += Math.sign(wantSpool - h.spool) * Math.min(Math.abs(wantSpool - h.spool), dt / 1.4);
    h.idle = h.job || h.goal ? 0 : h.idle + dt;
    const g = h.goal;
    if (!g || h.spool < 0.98) {
      h.vel.multiplyScalar(Math.exp(-dt * 3));
      h.pitch *= 0.9;
      h.bank *= 0.9;
      return;
    }
    const y0 = restHeight(h);
    const cruise = this.heights!.top + LAYER.helo * k + y0;
    const dx = g.x - h.pos.x;
    const dz = g.z - h.pos.z;
    const dist = Math.hypot(dx, dz);
    const vmax = 44 * k;
    const acc = 20 * k;
    // Height to clear: the rooftops under the rotor and along the next couple of seconds of flight.
    const speed0 = Math.hypot(h.vel.x, h.vel.z);
    const r = reach(h) * 0.8;
    const ahead = dist > 1 ? this.heights!.along(h.pos.x, h.pos.z, dx, dz, Math.min(dist, speed0 * 2 + r), r) : this.heights!.at(h.pos.x, h.pos.z, r);
    const floor = ahead > 0 ? ahead + underside(h, 0.45) + 2 * k : 0;
    // Climb before moving off; slow and descend on the way in.
    if (g.land) g.y = y0;
    let altWant = dist > 22 * k ? cruise : g.y + (cruise - g.y) * Math.max(0, (dist - 2) / (20 * k));
    altWant = Math.max(clamp(altWant, h.minY, h.maxY), floor);
    h.holdY = altWant;
    const vy = clamp((altWant - h.pos.y) * 1.6, -8 * k, 9 * k);
    // Hold off moving sideways until clear of what's ahead (and, leaving a pad, well up).
    const lifted = clamp((h.pos.y - y0) / (cruise * 0.45 - y0 * 0.45 || 1), 0, 1);
    const clear = floor > 0 ? clamp(1 - (floor - h.pos.y) / (3 * k), 0, 1) : 1;
    const vd = Math.min(vmax, Math.sqrt(2 * acc * 0.7 * Math.max(0, dist - 0.2))) * (dist > 3 ? Math.min(lifted, clear) : clear);
    const want = this.tmpDir.set(dist > 1e-3 ? (dx / dist) * vd : 0, 0, dist > 1e-3 ? (dz / dist) * vd : 0);
    const dv = want.sub(h.vel.clone().setY(0));
    const before = h.vel.length();
    if (dv.length() > acc * dt) dv.setLength(acc * dt);
    h.vel.x += dv.x;
    h.vel.z += dv.z;
    h.pos.x += h.vel.x * dt;
    h.pos.z += h.vel.z * dt;
    h.pos.y += vy * dt;
    if (g.land && dist < 0.8 && h.minY <= y0) {
      h.pos.y = Math.max(g.y, h.pos.y - 5 * k * dt);
      if (h.pos.y <= g.y + 0.02) {
        h.pos.set(g.x, g.y, g.z);
        h.vel.set(0, 0, 0);
        h.grounded = true;
        h.goal = null;
      }
    } else {
      h.grounded = false;
    }
    const speed = Math.hypot(h.vel.x, h.vel.z);
    let turn = 0;
    if (speed > 3) {
      const target = headingOf(h.vel.x, h.vel.z);
      const err = wrap(target - h.heading);
      turn = clamp(err * 2.2, -1.8, 1.8);
      h.heading = wrap(h.heading + turn * dt);
    }
    const along = (speed - before) / Math.max(dt, 1e-3);
    h.pitch += (-(speed / vmax) * 0.16 - along * 0.006 - h.pitch) * Math.min(1, dt * 4);
    h.bank += (clamp(-turn * speed * 0.012, -0.45, 0.45) - h.bank) * Math.min(1, dt * 4);
  }

  // ── Orbits ────────────────────────────────────────────────────────────────

  private flyOrbit(o: Orbiter, dt: number): void {
    o.center.lerp(o.want, 1 - Math.exp(-dt * 0.5));
    o.r += (o.wantR - o.r) * (1 - Math.exp(-dt * 0.6));
    const rx = o.rx * o.r;
    const rz = o.rz * o.r;
    o.angle += (o.dir * o.speed * this.k * dt) / Math.max(10, (rx + rz) / 2);
    const x = o.center.x + Math.cos(o.angle) * rx;
    const z = o.center.z + Math.sin(o.angle) * rz;
    const dx = -Math.sin(o.angle) * rx * o.dir;
    const dz = Math.cos(o.angle) * rz * o.dir;
    o.pos.set(x, o.center.y, z);
    o.heading = headingOf(dx, dz);
    o.bank = o.dir * (o.ac.kind === "gunship" ? 0.38 : 0.18);
    o.pitch = 0.02;
  }

  // ── Strikes ───────────────────────────────────────────────────────────────

  /** The gunship engages each target; `onHit` brings the building down when the heavy round lands. */
  strike(targets: StrikeTarget[], onHit: (t: StrikeTarget) => void): void {
    const g = this.gunship;
    if (!g || !targets.length) return;
    let at = Math.max(this.time + 0.4, ...this.shots.map((s) => s.at + 0.9));
    // A clip of 40mm to range each building, then the 105mm. A big demolition goes faster: just the 105mm, a beat apart.
    const brief = targets.length > 3;
    for (const t of targets) {
      if (!brief) for (let i = 0; i < 4; i++) this.shots.push({ at: (at += 60 / GUNS.bofors.rpm), target: t, gun: "bofors" });
      this.shots.push({ at: (at += brief ? 1 : 0.9), target: t, gun: "m102", onHit: () => onHit(t) });
      if (!brief) at += 1.2;
    }
    // Swing the orbit over the targets for a pylon turn.
    const cx = targets.reduce((s, t) => s + t.x, 0) / targets.length;
    const cz = targets.reduce((s, t) => s + t.z, 0) / targets.length;
    g.want.set(cx, g.center.y, cz);
    g.wantR = 0.6;
    this.strikeCooldown = at - this.time + 8;
  }

  setEffects(level: EffectsLevel): void {
    this.effects = level;
    this.fx.setLevel(level);
  }

  /** Show or hide the air wing. Hidden, any strike already called lands at once. */
  setVehicles(on: boolean): void {
    this.vehicles = on;
    this.fleet.visible = on;
    this.shadowGroup.visible = on;
    if (on) return;
    for (const s of this.shots.splice(0)) s.onHit?.();
    for (const id of [...this.lifts.keys()]) this.endLift(id);
  }

  /** Buildings agents are working on: the gunship keeps them under fire, and the F-35s attack them. */
  setTargets(targets: StrikeTarget[]): void {
    this.targets = targets;
  }

  /** Stop shooting at a building (it's coming down). */
  dropTarget(path: string): void {
    this.down.add(path);
    this.targets = this.targets.filter((t) => t.path !== path);
    for (const st of this.stations) if (st.target?.path === path) st.target = null;
  }

  /** One gunship round: a muzzle flash, a tracer, and `onHit` where it lands. */
  private round(kind: keyof typeof GUN_PORTS, spec: GunSpec, t: StrikeTarget, spread: number, onHit: (at: Vector3) => void): void {
    const to = new Vector3(t.x + (Math.random() - 0.5) * spread, t.height + 0.3, t.z + (Math.random() - 0.5) * spread);
    // With effects off there's nothing to see in flight: the round lands at once.
    if (this.effects === "off") return onHit(to);
    const from = GUN_PORTS[kind].clone().applyMatrix4(this.gunship!.ac.root.matrixWorld);
    this.fx.muzzle(from, spec.flash);
    this.tracers.fire(from, to, spec, () => onHit(to));
  }

  /** The guns point out the port side: only targets off the left wing can be engaged. */
  private inArc(t: StrikeTarget): boolean {
    const g = this.gunship!;
    const dx = t.x - g.pos.x;
    const dz = t.z - g.pos.z;
    return (dx * -Math.sin(g.heading) + dz * -Math.cos(g.heading)) / (Math.hypot(dx, dz) || 1) > 0.2;
  }

  private fire(dt: number): void {
    // Called strikes own the guns until the building is down.
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]!;
      // Wait (a little) for the target to come round off the left wing, where the guns point.
      if (s.at > this.time || (!this.inArc(s.target) && this.time < s.at + ARC_WAIT)) continue;
      this.shots.splice(i, 1);
      const t = s.target;
      const spec = GUNS[s.gun];
      const kill = s.onHit;
      this.round(s.gun === "m102" ? "m102" : "bofors", spec, t, kill ? 0 : Math.min(t.w, t.h) * 0.5, (at) => {
        if (!kill) return this.fx.impact(at, spec.hit, false);
        // Thin towers still get a proper fireball.
        this.fx.explosion(at.x, at.y, at.z, Math.max(t.w, t.h, 9 * this.k) * 0.42, true);
        kill();
      });
    }
    // Otherwise each gun works over whatever the squad is working on, at its own rate
    // (half rate on medium effects; not at all below that).
    const striking = this.shots.length > 0;
    const ambient = this.vehicles && (this.effects === "high" || this.effects === "medium");
    for (const st of this.stations) {
      if (!st.gun.busy) st.target = this.targets.length ? this.targets[Math.floor(Math.random() * this.targets.length)]! : null;
      const t = st.target;
      const shots = st.gun.tick(this.effects === "medium" ? dt / 2 : dt, ambient && !striking && t !== null && this.inArc(t));
      for (let i = 0; i < shots; i++) this.round(st.kind, st.gun.spec, t!, st.gun.spec.spread * this.k, (at) => this.fx.impact(at, st.gun.spec.hit, st.kind === "m102"));
    }
    if (this.strikeCooldown > 0) {
      this.strikeCooldown -= dt;
      if (this.strikeCooldown <= 0 && this.city) {
        const b = this.city.bounds;
        this.gunship!.want.set(b.x + b.w / 2, this.gunship!.center.y, b.y + b.h / 2);
        this.gunship!.wantR = 1;
      }
    }
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  /** `ppw`: CSS pixels per world unit at ground level; `camHeight`: the camera's height. */
  update(dt: number, ppw: number, camHeight: number): void {
    if (!this.city) return;
    this.time += dt;
    const all: Flyer[] = [...this.helos, ...this.jets.map((j) => j.f), this.uav!, this.gunship!];
    const before = all.map((f) => f.pos.clone());
    separate(
      [...this.helos, ...this.jets.map((j) => j.f)],
      [...this.helos.filter((h) => !h.grounded), ...this.jets.filter((j) => j.airborne).map((j) => j.f), this.uav!, this.gunship!],
      new Set([this.uav!, this.gunship!]),
      this.k,
    );
    this.updateLifts(dt);
    for (const h of this.helos) this.flyHelo(h, dt);
    for (const j of this.jets) j.update(dt);
    if (this.uav) this.flyOrbit(this.uav, dt);
    if (this.gunship) this.flyOrbit(this.gunship, dt);
    all.forEach((f, i) => f.motion.copy(f.pos).sub(before[i]!).divideScalar(Math.max(dt, 1e-3)));
    this.fire(dt);
    this.tracers.update(dt, ppw);
    this.ordnance.update(dt);
    this.fx.update(dt);

    const blink = this.time % 1.1 < 0.09;
    if (this.radar) this.radar.rotation.y += dt * 2.2;
    if (this.towerBeacon) this.towerBeacon.visible = (this.time + 0.5) % 1.4 < 0.12;
    for (const f of all) {
      const ac = f.ac;
      // Keep a minimum on-screen size, like the game's map icons (closer = bigger).
      const near = camHeight / Math.max(1, camHeight - f.pos.y);
      const scale = Math.max(1, MIN_PX[ac.kind] / (ac.length * ppw * near));
      const groundedBefore = restHeight(f);
      f.scale += (scale - f.scale) * Math.min(1, dt * 6);
      // Parked aircraft stay on their wheels as their size changes.
      if (f.pos.y <= groundedBefore + 0.01) f.pos.y = restHeight(f);
      f.fade = clamp((camHeight - f.pos.y - 4 * this.k) / (14 * this.k), 0, 1);
      ac.root.visible = f.fade > 0.02;
      ac.root.position.copy(f.pos);
      ac.root.rotation.set(f.bank, f.heading, f.pitch, "YZX");
      ac.root.scale.setScalar(ac.length * f.scale);
      for (const m of ac.materials) m.opacity = f.fade;
      for (const s of ac.spinners) s.part.rotation[s.axis] += s.rate * Math.PI * 2 * f.spool * dt;
      for (const d of ac.discs) (d.material as MeshBasicMaterial).opacity = 0.2 * f.spool * f.spool * f.fade;
      ac.beacon.visible = blink && f.spool > 0.2;
      ac.root.updateMatrixWorld(true);
    }
    for (const s of this.shadows) {
      s.shadow.visible = s.ac.root.visible;
      s.shadow.matrix.multiplyMatrices(this.project, s.caster.matrixWorld);
    }
  }
}
