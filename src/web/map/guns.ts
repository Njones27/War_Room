// Aircraft guns, after the real ones. Rate of fire sets how often a round
// leaves the barrel, muzzle velocity sets its time of flight, and every round
// is drawn as a yellow tracer dash: the faster the gun fires, the shorter the
// dash, so a Gatling reads as a dotted stream and the howitzer as long streaks.
import { AdditiveBlending, BoxGeometry, DynamicDrawUsage, InstancedMesh, MeshBasicMaterial, Object3D, Quaternion, Vector3 } from "three";

export type GunKind = "gau12" | "bofors" | "m102" | "gau22";

export interface GunSpec {
  name: string;
  /** Rounds per minute. */
  rpm: number;
  /** Muzzle velocity in m/s. */
  mv: number;
  /** Tracer dash length (world units on a ~320-unit map). */
  dash: number;
  /** Rounds per burst [min, max]. */
  burst: [number, number];
  /** Pause between bursts in seconds [min, max]. */
  rest: [number, number];
  /** Scatter at the target. */
  spread: number;
  /** Size of the hit and of the muzzle flash. */
  hit: number;
  flash: number;
}

export const GUNS: Record<GunKind, GunSpec> = {
  // AC-130U: GAU-12/U Equalizer 25mm five-barrel Gatling, held to 1,800 rpm on the gunship; ~1,040 m/s.
  gau12: { name: "25mm GAU-12 Equalizer", rpm: 1800, mv: 1040, dash: 2.4, burst: [30, 60], rest: [2.5, 5], spread: 4.5, hit: 0.9, flash: 1.4 },
  // 40mm Bofors L/60: fed in 4-round clips, up to ~100-120 rpm, very accurate; ~880 m/s.
  bofors: { name: "40mm Bofors L/60", rpm: 100, mv: 880, dash: 6.5, burst: [4, 8], rest: [3, 6], spread: 1.6, hit: 2.4, flash: 2.6 },
  // 105mm M102 howitzer: hand-loaded, ~6-10 rpm, a slow heavy shell; ~494 m/s.
  m102: { name: "105mm M102 Howitzer", rpm: 8, mv: 494, dash: 15, burst: [1, 2], rest: [6, 12], spread: 0.8, hit: 4.6, flash: 4.2 },
  // F-35A: GAU-22/A 25mm four-barrel Gatling, ~3,300 rpm, only 180 rounds aboard, so short bursts; ~1,040 m/s.
  gau22: { name: "25mm GAU-22/A", rpm: 3300, mv: 1040, dash: 1.8, burst: [40, 60], rest: [0.6, 1.2], spread: 3.5, hit: 0.8, flash: 1.2 },
};

/**
 * Map units per second for each m/s of muzzle velocity. Slowed well below
 * scale so a Gatling's rounds read as a dotted line: a 25mm round crosses
 * ~200 units in about 0.65 s, a 105mm shell in about 1.35 s.
 */
const SPEED_PER_MV = 0.3;

interface Round {
  from: Vector3;
  dir: Vector3;
  dist: number;
  travelled: number;
  speed: number;
  dash: number;
  onHit: () => void;
}

/** Rounds in flight, drawn as instanced yellow dashes. */
export class Tracers {
  readonly mesh: InstancedMesh;
  private rounds: Round[] = [];
  private readonly tmp = new Object3D();
  private readonly x = new Vector3(1, 0, 0);
  private readonly q = new Quaternion();
  private k = 1;

  constructor(private readonly capacity = 900) {
    this.mesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  setScale(k: number): void {
    this.k = k;
  }

  clear(): void {
    this.rounds = [];
    this.mesh.count = 0;
  }

  /** Fire one round; `onHit` runs when it arrives. */
  fire(from: Vector3, to: Vector3, gun: GunSpec, onHit: () => void): void {
    if (this.rounds.length >= this.capacity) return;
    const d = to.clone().sub(from);
    const dist = d.length();
    this.rounds.push({ from: from.clone(), dir: d.normalize(), dist, travelled: 0, speed: gun.mv * SPEED_PER_MV * this.k, dash: gun.dash * this.k, onHit });
  }

  /** `ppw`: CSS pixels per world unit, so dashes stay at least ~1.5 px thick. */
  update(dt: number, ppw: number): void {
    const thick = Math.max(0.28 * this.k, 1.5 / Math.max(ppw, 1e-3));
    let n = 0;
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i]!;
      r.travelled += r.speed * dt;
      if (r.travelled >= r.dist) {
        this.rounds.splice(i, 1);
        r.onHit();
        continue;
      }
      const len = Math.min(r.dash, r.travelled);
      this.q.setFromUnitVectors(this.x, r.dir);
      this.tmp.position.copy(r.from).addScaledVector(r.dir, r.travelled - len / 2);
      this.tmp.quaternion.copy(this.q);
      this.tmp.scale.set(len, thick, thick);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(n++, this.tmp.matrix);
    }
    this.mesh.count = n;
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** One gun's firing cycle: bursts at its rate of fire, then a rest. */
export class GunStation {
  private cooldown: number;
  private left = 0;
  private next = 0;

  constructor(
    readonly spec: GunSpec,
    stagger = 0,
  ) {
    this.cooldown = stagger;
  }

  /** Rounds to fire this frame (0 when resting or `canFire` is false). */
  tick(dt: number, canFire: boolean): number {
    if (this.left <= 0) {
      this.cooldown -= dt;
      if (this.cooldown > 0 || !canFire) return 0;
      const [lo, hi] = this.spec.burst;
      this.left = lo + Math.floor(Math.random() * (hi - lo + 1));
      this.next = 0;
    }
    if (!canFire) {
      this.endBurst();
      return 0;
    }
    this.next -= dt;
    let shots = 0;
    while (this.next <= 0 && this.left > 0) {
      shots++;
      this.left--;
      this.next += 60 / this.spec.rpm;
    }
    if (this.left <= 0) this.endBurst();
    return shots;
  }

  /** Mid-burst. */
  get busy(): boolean {
    return this.left > 0;
  }

  private endBurst(): void {
    this.left = 0;
    const [lo, hi] = this.spec.rest;
    this.cooldown = lo + Math.random() * (hi - lo);
  }
}
