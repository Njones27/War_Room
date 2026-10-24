// F-35A Lightning IIs: the strike fighter, built for air-to-ground. Each
// sortie: taxi out from the airbase apron, take off east along the runway,
// fly a mission (a wide patrol, attack passes on a building being worked on
// with the gun, a guided bomb or a missile, or a wheel over the fighting),
// then a long straight-in final westbound and a landing.
//
// In the air they fly a simple flight model: turn rate capped by a minimum
// turn radius and eased in by roll rate, so turns are wide and smooth. They
// always hold height above the buildings near them and along their path, and
// stay inside the height band the air wing sets to keep them clear of others.
import { Vector3 } from "three";
import type { CityModel } from "../../shared/city";
import type { StrikeTarget } from "./air";
import type { Airfield } from "./airfield";
import { type Flyer, headingOf, reach, restHeight, Route, underside, wrap } from "./flight";
import type { Fx } from "./fx";
import { GUNS, GunStation, type Tracers } from "./guns";
import type { Ordnance } from "./ordnance";
import type { HeightField } from "./terrain";

/** Cruise speed, world units/s on a ~320-unit map. */
const CRUISE = 84;
/** Minimum turn radius. */
const R_MIN = 55;
/** How fast the turn rate can change (rad/s²): the roll-in. */
const ROLL = 1.2;
const ACCEL = 22;
const CLIMB = 12;
/** Approach speed over the threshold. */
const V_APP = 58;
/** Glide slope: height lost per unit flown on final. */
const GLIDE = 0.085;
/** The initial approach fix: this far out on the extended centreline. */
const FIX_OUT = 360;
/** Line following aims this far ahead along the line (× R_MIN): far enough to settle without overshoot. */
const LOOKAHEAD = 1.6;
/** Seconds of flight ahead checked for buildings. */
const LOOK_SECONDS = 2.5;

type Weapon = "gun" | "bomb" | "missile";

type Leg =
  | { kind: "goto"; x: number; z: number; alt: number; speed: number; climbout?: boolean }
  | { kind: "orbit"; x: number; z: number; r: number; alt: number; speed: number; turns: number; swept: number; last: number | null }
  | { kind: "attack"; target: StrikeTarget; ax: number; az: number; locked: boolean; alt: number; speed: number; weapon: Weapon; released: boolean }
  | { kind: "final"; ready: boolean };

interface Guide {
  heading: number;
  alt: number;
  speed: number;
  done: boolean;
  /** Planned climb rate along a slope (negative descends), so height tracks it without lag. */
  slope?: number;
}

export interface FighterDeps {
  field: () => Airfield;
  city: () => CityModel;
  heights: () => HeightField;
  /** Map scale: 1 on a ~320-unit map. */
  k: () => number;
  /** Buildings agents are working on. */
  targets: () => StrikeTarget[];
  /** Whether another jet's use of the runway stops this one: taking off (`depart`) or committing to final. */
  runwayBusy: (self: Fighter, depart: boolean) => boolean;
  tracers: Tracers;
  ordnance: Ordnance;
  fx: Fx;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Fighter {
  readonly park = new Vector3();
  private mode: "parked" | "ground" | "air" = "parked";
  private route: Route | null = null;
  private landing = false;
  /** From leaving the stand until the climb-out is flown. */
  private departing = false;
  /** From heading for the approach until parked again. */
  private arriving = false;
  private wait: number;
  private plan: Leg[] = [];
  private speed = 0;
  private turn = 0;
  private vy = 0;
  private vr = 60;
  private readonly gun = new GunStation(GUNS.gau22);
  private readonly tmpPos = new Vector3();
  private readonly tmpDir = new Vector3();

  constructor(
    readonly f: Flyer,
    private readonly index: number,
    private readonly d: FighterDeps,
  ) {
    this.wait = 3 + index * 9;
  }

  /** Its stand on the apron (the city was rebuilt). */
  setStand(x: number, z: number): void {
    this.park.set(x, restHeight(this.f), z);
    if (this.mode === "parked") {
      this.f.pos.copy(this.park);
      // Parked nose toward the runway.
      this.f.heading = this.side() > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  get airborne(): boolean {
    return this.mode === "air";
  }

  /**
   * How this jet is using the runway: "departing" (taxiing out, rolling or
   * climbing out), "landing" (established on final, or rolling out),
   * "arriving" (on its way to the approach), or "none".
   */
  runwayUse(): "none" | "departing" | "arriving" | "landing" {
    if (this.departing) return "departing";
    if (!this.arriving) return "none";
    // Committed to final (even while still flying out to the approach fix), or rolling out.
    const final = this.plan.find((l) => l.kind === "final");
    return this.mode === "ground" || (final?.kind === "final" && final.ready) ? "landing" : "arriving";
  }

  update(dt: number): void {
    if (this.mode === "parked") {
      const f = this.f;
      f.spool = Math.max(0, f.spool - dt * 0.3);
      f.bank *= 0.9;
      f.pitch *= 0.9;
      this.wait -= dt;
      if (this.wait <= 0) {
        if (this.d.runwayBusy(this, true)) this.wait = 2;
        else this.takeoff();
      }
    } else if (this.mode === "ground") this.roll(dt);
    else this.fly(dt);
  }

  // ── Ground ────────────────────────────────────────────────────────────────

  /** Which side of the runway the apron is on: +1 south, -1 north. */
  private side(): number {
    return Math.sign(this.park.z - this.d.field().runway.z) || 1;
  }

  private takeoff(): void {
    const r = this.d.field().runway;
    const y0 = restHeight(this.f);
    const p = this.park;
    const s = this.side();
    this.vr = Math.min(68, (r.x1 - r.x0) * 0.85);
    this.route = new Route()
      .add([p.clone(), new Vector3(p.x + 2, y0, r.z + 3.5 * s), new Vector3(p.x + 7, y0, r.z), new Vector3(p.x + 11, y0, r.z)], [3, 5, 6, 8])
      .add([new Vector3(p.x + 11, y0, r.z), new Vector3(r.x1 - 2, y0, r.z)], [8, this.vr]);
    this.mode = "ground";
    this.landing = false;
    this.departing = true;
    this.f.spool = 1;
  }

  private touchdown(): void {
    const r = this.d.field().runway;
    const y0 = restHeight(this.f);
    const p = this.park;
    const s = this.side();
    const f = this.f;
    this.route = new Route()
      .add([new Vector3(f.pos.x, y0, r.z), new Vector3(p.x + 13, y0, r.z)], [this.speed, 6])
      .add([new Vector3(p.x + 13, y0, r.z), new Vector3(p.x + 8, y0, r.z + s), new Vector3(p.x + 3, y0, r.z + 4.5 * s), p.clone()], [6, 5, 4, 2]);
    this.mode = "ground";
    this.landing = true;
    f.heading = Math.PI;
    this.turn = 0;
  }

  private roll(dt: number): void {
    const f = this.f;
    const route = this.route!;
    const v = route.step(dt, this.tmpPos, this.tmpDir);
    f.pos.copy(this.tmpPos);
    f.pitch *= 0.85;
    f.bank *= 0.85;
    if (route.done) {
      this.route = null;
      if (this.landing) {
        this.mode = "parked";
        this.arriving = false;
        this.wait = 6 + Math.random() * 10;
        f.pos.copy(this.park);
      } else {
        // Rotate and climb out straight ahead, over open ground.
        this.mode = "air";
        this.speed = this.vr;
        this.turn = 0;
        f.heading = 0;
        this.plan = this.mission();
      }
      return;
    }
    this.speed = v;
    const err = wrap(headingOf(this.tmpDir.x, this.tmpDir.z) - f.heading);
    f.heading = wrap(f.heading + clamp(err * 8, -2.4, 2.4) * dt);
  }

  // ── Missions ──────────────────────────────────────────────────────────────

  private mission(): Leg[] {
    const k = this.d.k();
    const r = this.d.field().runway;
    const b = this.d.city().bounds;
    const top = this.d.heights().top;
    const cruise = CRUISE * k;
    // Each jet keeps its own height band above the rooftops.
    const alt = top + (22 + this.index * 8) * k;
    const legs: Leg[] = [{ kind: "goto", x: r.x1 + 110 * k, z: r.z, alt: top + 12 * k, speed: cruise, climbout: true }];
    const targets = this.d.targets();
    const target = targets.length ? targets[Math.floor(Math.random() * targets.length)]! : null;
    const roll = Math.random();
    if (target && roll < 0.5) {
      // Attack passes: a racetrack through the target, a weapon picked for each pass.
      const a = Math.random() * Math.PI * 2;
      const ax = Math.cos(a);
      const az = Math.sin(a);
      const run = 320 * k;
      const pass = (): Leg => {
        const w = Math.random();
        const weapon: Weapon = w < 0.45 ? "gun" : w < 0.75 ? "bomb" : "missile";
        const over = weapon === "gun" ? 9 : weapon === "bomb" ? 18 : 24;
        return { kind: "attack", target, ax: 0, az: 0, locked: false, alt: target.height + over * k, speed: cruise * 0.9, weapon, released: false };
      };
      legs.push(
        { kind: "goto", x: target.x - ax * run, z: target.z - az * run, alt, speed: cruise },
        pass(),
        { kind: "goto", x: target.x + ax * run, z: target.z + az * run, alt, speed: cruise },
        pass(),
      );
    } else if (target && roll < 0.75) {
      // A wheel over the fighting.
      legs.push({ kind: "orbit", x: target.x, z: target.z, r: 1.45 * R_MIN * k, alt: alt - 4 * k, speed: cruise * 0.85, turns: 1.5, swept: 0, last: null });
    } else {
      // A wide patrol loop around the city.
      const cx = b.x + b.w / 2;
      const cz = b.y + b.h / 2;
      const n = 4 + Math.floor(Math.random() * 2);
      const a0 = Math.random() * Math.PI * 2;
      const dir = Math.random() < 0.5 ? 1 : -1;
      for (let s = 0; s < n; s++) {
        const a = a0 + dir * (s / n) * Math.PI * 2.2;
        legs.push({ kind: "goto", x: cx + Math.cos(a) * b.w * 0.42, z: cz + Math.sin(a) * b.h * 0.4, alt: alt + (Math.random() - 0.5) * 6 * k, speed: cruise });
      }
    }
    legs.push({ kind: "final", ready: false });
    return legs;
  }

  // ── Air ───────────────────────────────────────────────────────────────────

  private fly(dt: number): void {
    const f = this.f;
    const k = this.d.k();
    const r = this.d.field().runway;
    let leg = this.plan[0];
    if (leg?.kind === "final" && !leg.ready) {
      this.arriving = true;
      if (this.d.runwayBusy(this, false)) {
        // Someone's landing or rolling: hold south of the approach fix until it's clear.
        const fix = this.initialFix();
        this.plan.unshift({ kind: "orbit", x: fix.x, z: r.z + 1.8 * R_MIN * k, r: 1.45 * R_MIN * k, alt: this.d.heights().top + 16 * k, speed: CRUISE * k * 0.75, turns: 1, swept: 0, last: null });
      } else {
        // Line up for a long straight-in final from well east of the runway.
        leg.ready = true;
        const out = f.pos.x - (r.x1 - 6);
        if (out < 230 * k || Math.abs(f.pos.z - r.z) > out * 0.35 || Math.abs(wrap(f.heading - Math.PI)) > 1.2) this.plan.unshift(this.initialFix());
      }
      leg = this.plan[0];
    }
    const g = leg ? this.guide(leg, dt) : { heading: f.heading, alt: f.pos.y, speed: this.speed, done: false };
    if (g.done && this.plan.shift() === leg && leg?.kind === "goto" && leg.climbout) this.departing = false;
    if (this.mode !== "air") return;

    const omegaMax = this.speed / (R_MIN * k);
    const cmd = clamp(wrap(g.heading - f.heading) * 2.4, -omegaMax, omegaMax);
    this.turn += clamp(cmd - this.turn, -ROLL * dt, ROLL * dt);
    f.heading = wrap(f.heading + this.turn * dt);
    this.speed += clamp(g.speed - this.speed, -ACCEL * k * dt, ACCEL * k * dt);
    // Never below the rooftops here or along the next few seconds of flight.
    const floor = this.d.heights().along(f.pos.x, f.pos.z, Math.cos(f.heading), -Math.sin(f.heading), this.speed * LOOK_SECONDS, reach(f) * 0.7);
    const minAlt = floor > 0 ? floor + underside(f) + 3 * k : restHeight(f);
    const want = clamp(g.alt, f.minY, f.maxY);
    const alt = Math.max(want, minAlt);
    this.vy = clamp((alt === want ? (g.slope ?? 0) : 0) + (alt - f.pos.y) * 1.2, -CLIMB * k, CLIMB * k);
    f.pos.x += Math.cos(f.heading) * this.speed * dt;
    f.pos.z -= Math.sin(f.heading) * this.speed * dt;
    f.pos.y = Math.max(restHeight(f), f.pos.y + this.vy * dt);
    f.pitch += (Math.atan2(this.vy, this.speed) - f.pitch) * Math.min(1, dt * 4);
    f.bank += (-Math.atan((2.1 * this.turn * R_MIN * k) / Math.max(this.speed, 1)) - f.bank) * Math.min(1, dt * 6);
  }

  /** The initial approach fix: on the extended centreline, far enough out to settle. */
  private initialFix(): Leg & { kind: "goto" } {
    const k = this.d.k();
    const r = this.d.field().runway;
    return { kind: "goto", x: r.x1 - 6 + FIX_OUT * k, z: r.z, alt: this.d.heights().top + 12 * k, speed: CRUISE * k * 0.8 };
  }

  /** Heading that settles onto the line through (px, pz) along (ax, az): aim at a point ahead on it. */
  private follow(px: number, pz: number, ax: number, az: number, lookahead = LOOKAHEAD * R_MIN * this.d.k()): { heading: number; along: number; cross: number } {
    const f = this.f;
    const rx = f.pos.x - px;
    const rz = f.pos.z - pz;
    const along = rx * ax + rz * az;
    const cross = rx * az - rz * ax;
    const ahead = along + lookahead;
    return { heading: headingOf(px + ax * ahead - f.pos.x, pz + az * ahead - f.pos.z), along, cross };
  }

  private guide(leg: Leg, dt: number): Guide {
    const f = this.f;
    const k = this.d.k();
    switch (leg.kind) {
      case "goto": {
        const dx = leg.x - f.pos.x;
        const dz = leg.z - f.pos.z;
        return { heading: headingOf(dx, dz), alt: leg.alt, speed: leg.speed, done: Math.hypot(dx, dz) < 1.15 * R_MIN * k };
      }
      case "orbit": {
        const dx = f.pos.x - leg.x;
        const dz = f.pos.z - leg.z;
        const d = Math.hypot(dx, dz);
        const theta = headingOf(dx, dz);
        if (leg.last !== null) leg.swept += Math.abs(wrap(theta - leg.last));
        leg.last = theta;
        // Counter-clockwise: the circle's tangent, bent toward the circle when off it.
        const heading = theta + Math.PI / 2 + clamp(Math.atan((2 * (d - leg.r)) / leg.r), -1.2, 1.2);
        return { heading, alt: leg.alt, speed: leg.speed, done: leg.swept >= leg.turns * Math.PI * 2 };
      }
      case "attack": {
        const t = leg.target;
        if (!leg.locked) {
          // Turn in toward the target; once pointing at it from far enough out, that line is the run.
          const bearing = headingOf(t.x - f.pos.x, t.z - f.pos.z);
          const range = Math.hypot(t.x - f.pos.x, t.z - f.pos.z);
          const needed = (leg.weapon === "missile" ? 190 : 150) * k;
          if (Math.abs(wrap(f.heading - bearing)) < 0.12 && range > needed) {
            leg.ax = Math.cos(bearing);
            leg.az = -Math.sin(bearing);
            leg.locked = true;
          }
          // Too close to set up a run: skip this pass and fly on.
          return { heading: bearing, alt: leg.alt + Math.max(0, range - 50 * k) * (leg.weapon === "gun" ? 0.1 : 0), speed: leg.speed, done: !leg.locked && range < needed * 0.55 };
        }
        const axis = headingOf(leg.ax, leg.az);
        const { heading, along, cross } = this.follow(t.x, t.z, leg.ax, leg.az); // along < 0 before the target
        const range = -along;
        const lined = Math.abs(cross) < 8 * k && Math.abs(wrap(f.heading - axis)) < 0.25;
        if (leg.weapon === "gun") {
          const shots = this.gun.tick(dt, lined && range > 18 * k && range < 110 * k);
          if (shots) this.strafe(t, shots);
        } else if (!leg.released && lined && (leg.weapon === "bomb" ? range < 70 * k && range > 40 * k : range < 160 * k && range > 100 * k)) {
          leg.released = true;
          this.release(t, leg.weapon);
        }
        // Gun runs dive from the run-in height to the pass; stores are released level.
        const diving = leg.weapon === "gun" && range > 50 * k;
        const alt = leg.alt + (leg.weapon === "gun" ? Math.max(0, range - 50 * k) * 0.1 : 0);
        return { heading, alt, speed: leg.speed, done: along > 35 * k, slope: diving ? -this.speed * 0.1 : 0 };
      }
      case "final": {
        const r = this.d.field().runway;
        const tdx = r.x1 - 6;
        // Aim closer in as the runway nears, so the last of the offset is gone well before the threshold.
        const line = this.follow(tdx, r.z, -1, 0, clamp(0.45 * (f.pos.x - tdx), 32 * k, LOOKAHEAD * R_MIN * k));
        const out = -line.along; // distance to the touchdown point
        const cross = f.pos.z - r.z;
        const y0 = restHeight(f);
        // Trim out the last of any drift just before the wheels touch.
        if (out < 25 * k) f.pos.z -= cross * Math.min(1, dt * 2);
        const misaligned = out < 15 * k && Math.abs(cross) > 5;
        if (misaligned || out < -20) {
          // Go around and try again.
          leg.ready = false;
          this.plan.unshift(this.initialFix());
          return { heading: Math.PI, alt: this.d.heights().top + 12 * k, speed: CRUISE * k, done: false };
        }
        if (out < 8 && f.pos.y < y0 + 1.5) {
          this.touchdown();
          return { heading: Math.PI, alt: y0, speed: this.speed, done: true };
        }
        return {
          heading: line.heading,
          alt: y0 + Math.max(0, out - 5) * GLIDE,
          speed: clamp(V_APP + (out - 30 * k) * 0.3, V_APP, CRUISE * k * 0.85),
          done: false,
          slope: out > 5 ? -this.speed * GLIDE : 0,
        };
      }
    }
  }

  /** The nose gun: every round hits the roof. */
  private strafe(t: StrikeTarget, shots: number): void {
    const spec = GUNS.gau22;
    const k = this.d.k();
    const root = this.f.ac.root;
    root.updateMatrixWorld();
    const muzzle = new Vector3(0.46, 0.02, -0.06).applyMatrix4(root.matrixWorld);
    this.d.fx.muzzle(muzzle, spec.flash);
    for (let i = 0; i < shots; i++) {
      const to = new Vector3(t.x + (Math.random() - 0.5) * Math.min(t.w, spec.spread * k), t.height + 0.3, t.z + (Math.random() - 0.5) * Math.min(t.h, spec.spread * k));
      this.d.tracers.fire(muzzle, to, spec, () => this.d.fx.impact(to, spec.hit, false));
    }
  }

  /** A bomb off the belly or a missile off the wing, onto the roof. */
  private release(t: StrikeTarget, store: "bomb" | "missile"): void {
    const f = this.f;
    const root = f.ac.root;
    root.updateMatrixWorld();
    const to = new Vector3(t.x, t.height + 0.3, t.z);
    const size = Math.max(t.w, t.h, 8 * this.d.k());
    const burst = () => this.d.fx.explosion(to.x, to.y, to.z, size * (store === "bomb" ? 0.34 : 0.26), true);
    if (store === "bomb") {
      const from = new Vector3(0, -0.06, 0).applyMatrix4(root.matrixWorld);
      const vel = new Vector3(Math.cos(f.heading) * this.speed, 0, -Math.sin(f.heading) * this.speed);
      this.d.ordnance.drop(from, vel, to, burst);
    } else {
      const from = new Vector3(-0.1, -0.03, 0.2).applyMatrix4(root.matrixWorld);
      this.d.ordnance.launch(from, new Vector3(Math.cos(f.heading), -0.1, -Math.sin(f.heading)), to, burst);
    }
  }
}
