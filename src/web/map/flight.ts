// Shared flight bits: the state every aircraft carries, and ground routes
// (taxi, takeoff roll, rollout) as legs with speeds at their control points.
import { CatmullRomCurve3, type Curve, LineCurve3, Vector3 } from "three";
import type { Aircraft, AircraftKind } from "./aircraft";

export interface Flyer {
  ac: Aircraft;
  pos: Vector3;
  heading: number;
  pitch: number;
  bank: number;
  /** Rotor / engine power, 0..1. */
  spool: number;
  /** Size multiplier keeping the minimum on-screen size. */
  scale: number;
  fade: number;
  /** World velocity, measured each frame. */
  motion: Vector3;
  /** Height band that keeps it clear of other aircraft, set by the air wing each frame. */
  minY: number;
  maxY: number;
}

/** Bottom of the airframe below its origin, as a fraction of its length. */
export const GEAR: Record<AircraftKind, number> = { blackhawk: 0.08, lightning: 0.06, uav: 0.06, gunship: 0.09 };

/** Half the wingspan (or rotor) as a fraction of length. */
const SPAN: Record<AircraftKind, number> = { blackhawk: 0.52, lightning: 0.34, uav: 0.98, gunship: 0.68 };

/** Height of an aircraft's origin when it sits on its wheels. */
export const restHeight = (f: Flyer) => 0.4 + GEAR[f.ac.kind] * f.ac.length * f.scale;

/** How far out the airframe reaches from its origin, as drawn: its keep-out radius. */
export const reach = (f: Flyer) => f.ac.length * f.scale * Math.max(0.5, SPAN[f.ac.kind]);

/** How far the airframe can hang below its origin: its gear, or a wingtip in a hard bank. */
export const underside = (f: Flyer, bank = 1.15) => f.ac.length * f.scale * Math.max(GEAR[f.ac.kind], SPAN[f.ac.kind] * Math.sin(Math.min(Math.abs(bank), Math.PI / 2)));

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Heading of a direction in the XZ plane (0 = east, +π/2 = north). */
export const headingOf = (dx: number, dz: number) => Math.atan2(-dz, dx);

/** A path made of legs; speed is interpolated between each leg's control points. */
export class Route {
  private legs: { curve: Curve<Vector3>; length: number; knots: number[]; speeds: number[] }[] = [];
  private leg = 0;
  private s = 0;
  done = false;

  add(points: Vector3[], speeds: number[]): this {
    const curve: Curve<Vector3> = points.length === 2 ? new LineCurve3(points[0]!, points[1]!) : new CatmullRomCurve3(points, false, "centripetal");
    const div = (points.length - 1) * 24;
    curve.arcLengthDivisions = div;
    const lengths = curve.getLengths(div);
    const knots = points.map((_, i) => lengths[Math.round((i / (points.length - 1)) * div)]!);
    this.legs.push({ curve, length: lengths[lengths.length - 1]!, knots, speeds });
    return this;
  }

  /** Advance by dt; writes position and direction of travel, returns speed. */
  step(dt: number, pos: Vector3, dir: Vector3): number {
    let leg = this.legs[this.leg];
    if (!leg) {
      this.done = true;
      return 0;
    }
    let v = this.speedAt(leg, this.s);
    this.s += v * dt;
    while (leg && this.s >= leg.length) {
      this.s -= leg.length;
      this.leg++;
      leg = this.legs[this.leg];
      if (!leg) {
        const last = this.legs[this.legs.length - 1]!;
        pos.copy(last.curve.getPointAt(1));
        dir.copy(last.curve.getTangentAt(1));
        this.done = true;
        return 0;
      }
      v = this.speedAt(leg, this.s);
    }
    const u = Math.min(1, this.s / leg!.length);
    pos.copy(leg!.curve.getPointAt(u));
    dir.copy(leg!.curve.getTangentAt(u));
    return v;
  }

  private speedAt(leg: Route["legs"][number], s: number): number {
    const k = leg.knots;
    for (let i = 0; i < k.length - 1; i++) {
      if (s <= k[i + 1]! || i === k.length - 2) {
        const f = Math.min(1, Math.max(0, (s - k[i]!) / Math.max(1e-6, k[i + 1]! - k[i]!)));
        return Math.max(1.5, leg.speeds[i]! + (leg.speeds[i + 1]! - leg.speeds[i]!) * f);
      }
    }
    return leg.speeds[leg.speeds.length - 1]!;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Keep aircraft apart. Every mover's height band is reset, then for each pair
 * of airborne aircraft converging inside each other's reach within the next
 * few seconds, the higher one must climb to a safe height above the lower
 * and the lower descend below the higher, so the gap opens from both sides;
 * under a fixed orbit (gunship, UAV) only the lower one moves. Controllers
 * clamp to their band but never below the rooftops. Bands are set fresh every
 * frame, so once a pair has passed each goes back to its own height.
 */
export function separate(movers: Flyer[], airborne: Flyer[], fixed: Set<Flyer>, k: number): void {
  for (const f of movers) {
    f.minY = -Infinity;
    f.maxY = Infinity;
  }
  const extent = (f: Flyer) => Math.max(underside(f, f.bank), 0.12 * f.ac.length * f.scale);
  for (let i = 0; i < airborne.length; i++) {
    for (let j = i + 1; j < airborne.length; j++) {
      const a = airborne[i]!;
      const b = airborne[j]!;
      if (fixed.has(a) && fixed.has(b)) continue;
      const px = b.pos.x - a.pos.x;
      const py = b.pos.y - a.pos.y;
      const pz = b.pos.z - a.pos.z;
      const vx = b.motion.x - a.motion.x;
      const vy = b.motion.y - a.motion.y;
      const vz = b.motion.z - a.motion.z;
      const vv = vx * vx + vy * vy + vz * vz;
      const t = vv > 1e-6 ? clamp(-(px * vx + py * vy + pz * vz) / vv, 0, 3.5) : 0;
      if (Math.hypot(px + vx * t, pz + vz * t) >= (reach(a) + reach(b)) * 1.25 + 4 * k) continue;
      const needV = extent(a) + extent(b) + 4 * k;
      if (Math.abs(py + vy * t) >= needV) continue;
      const [up, low] = a.pos.y >= b.pos.y ? [a, b] : [b, a];
      low.maxY = Math.min(low.maxY, up.pos.y - needV);
      if (!fixed.has(up)) up.minY = Math.max(up.minY, low.pos.y + needV);
    }
  }
}
