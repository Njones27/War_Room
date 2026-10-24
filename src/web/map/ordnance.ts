// The F-35's air-to-ground stores besides its gun: a laser-guided bomb
// (GBU-12 Paveway II class) that arcs down from the release point onto the
// roof, and a missile that drops clear, lights its motor and flies in on a
// smoke trail. Both land exactly on the target and burst there.
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Quaternion, QuadraticBezierCurve3, Vector3 } from "three";
import type { Fx } from "./fx";

export type Store = "bomb" | "missile";

interface Shot {
  kind: Store;
  path: QuadraticBezierCurve3;
  t: number;
  dur: number;
  mesh: Mesh;
  onHit: () => void;
}

const X = new Vector3(1, 0, 0);

export class Ordnance {
  readonly group = new Group();
  private shots: Shot[] = [];
  private readonly body = new BoxGeometry(1, 0.22, 0.22);
  private readonly bombMat = new MeshLambertMaterial({ color: 0x4f5a52 });
  private readonly missileMat = new MeshLambertMaterial({ color: 0xc9d2d6 });
  private readonly flameMat = new MeshBasicMaterial({ color: 0xffc06a });
  private readonly q = new Quaternion();
  private k = 1;

  constructor(private readonly fx: Fx) {}

  setScale(k: number): void {
    this.k = k;
  }

  clear(): void {
    for (const s of this.shots) this.group.remove(s.mesh);
    this.shots = [];
  }

  /** Release a bomb at `from` moving with `vel`; it arcs down onto `to`. */
  drop(from: Vector3, vel: Vector3, to: Vector3, onHit: () => void): void {
    const ground = Math.hypot(to.x - from.x, to.z - from.z);
    const speed = Math.max(20, Math.hypot(vel.x, vel.z));
    const dur = Math.min(3.2, Math.max(1.1, ground / (speed * 0.75)));
    // Leaves level with the jet's motion, then falls away onto the target.
    const mid = from.clone().addScaledVector(vel.clone().setY(0), dur * 0.45);
    this.add("bomb", new QuadraticBezierCurve3(from.clone(), mid, to.clone()), dur, onHit);
  }

  /** Fire a missile from `from` along `dir`; it curves onto `to`. */
  launch(from: Vector3, dir: Vector3, to: Vector3, onHit: () => void): void {
    const dist = from.distanceTo(to);
    const mid = from.clone().addScaledVector(dir.clone().normalize(), dist * 0.4);
    mid.y = Math.max(mid.y - 2 * this.k, to.y + 4 * this.k);
    this.add("missile", new QuadraticBezierCurve3(from.clone(), mid, to.clone()), Math.max(0.9, dist / (190 * this.k)), onHit);
  }

  private add(kind: Store, path: QuadraticBezierCurve3, dur: number, onHit: () => void): void {
    const mesh = new Mesh(this.body, kind === "bomb" ? this.bombMat : this.missileMat);
    const len = (kind === "bomb" ? 1.6 : 2.2) * this.k;
    mesh.scale.set(len, len, len);
    if (kind === "missile") {
      const flame = new Mesh(this.body, this.flameMat);
      flame.scale.set(0.35, 0.8, 0.8);
      flame.position.x = -0.6;
      mesh.add(flame);
    }
    this.group.add(mesh);
    this.shots.push({ kind, path, t: 0, dur, mesh, onHit });
  }

  update(dt: number): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]!;
      s.t += dt;
      // The bomb picks up speed as it falls; the missile accelerates off the rail.
      const u = Math.min(1, s.kind === "bomb" ? s.t / s.dur : Math.pow(s.t / s.dur, 1.35));
      const p = s.path.getPoint(u);
      s.mesh.position.copy(p);
      s.mesh.quaternion.copy(this.q.setFromUnitVectors(X, s.path.getTangent(Math.max(0.001, u)).normalize()));
      if (s.kind === "missile") this.fx.trail(p);
      if (u >= 1) {
        this.group.remove(s.mesh);
        this.shots.splice(i, 1);
        s.onHit();
      }
    }
  }
}
