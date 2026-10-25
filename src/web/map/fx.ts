// Battlefield effects: explosions, gun flashes and hits, fire, smoke, debris, shockwaves
// and scorch marks. Particles are GPU points (one draw call per layer) sized
// in world units, so they scale with the map like everything else.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from "three";
import type { EffectsLevel } from "../lib/prefs";

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A soft, lumpy puff: overlapping radial blobs. */
const puffTexture = () =>
  canvasTexture(128, (g, s) => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9; i++) {
      const r = s * (0.16 + rnd() * 0.14);
      const x = s / 2 + (rnd() - 0.5) * s * 0.32;
      const y = s / 2 + (rnd() - 0.5) * s * 0.32;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.55)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.25)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  });

const glowTexture = () =>
  canvasTexture(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.75)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

const scorchTexture = () =>
  canvasTexture(128, (g, s) => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 14; i++) {
      const r = s * (0.18 + rnd() * 0.22);
      const x = s / 2 + (rnd() - 0.5) * s * 0.35;
      const y = s / 2 + (rnd() - 0.5) * s * 0.35;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(8,8,8,0.55)");
      grad.addColorStop(1, "rgba(8,8,8,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  });

interface Spawn {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  /** Size at end of life. */
  grow?: number;
  color: Color;
  /** Colour at end of life. */
  fade?: Color;
  alpha: number;
  drag?: number;
  gravity?: number;
}

/** A pool of camera-facing particles drawn as one GL_POINTS call. */
class Layer {
  readonly points: Points;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly rot: Float32Array;
  private readonly vel: Float32Array;
  private readonly st: Float32Array; // age, life, size0, size1, alpha0, drag, gravity, spin
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private cursor = 0;
  /** Share of spawns kept (the effects setting thins particles out). */
  density = 1;
  /** Whether anything was alive last frame (its fade-out still needs uploading). */
  private wasLive = false;
  private readonly geom = new BufferGeometry();
  private readonly vp = new Vector4();

  constructor(n: number, map: Texture, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.st = new Float32Array(n * 8);
    this.c0 = new Float32Array(n * 3);
    this.c1 = new Float32Array(n * 3);
    const attr = (name: string, arr: Float32Array, k: number) => {
      const a = new BufferAttribute(arr, k);
      a.setUsage(DynamicDrawUsage);
      this.geom.setAttribute(name, a);
    };
    attr("position", this.pos, 3);
    attr("aColor", this.col, 3);
    attr("aSize", this.size, 1);
    attr("aAlpha", this.alpha, 1);
    attr("aRot", this.rot, 1);
    const mat = new ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 400 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aRot;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRot;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aAlpha > 0.0 ? aSize * projectionMatrix[1][1] * uScale / -mv.z : 0.0;
          vColor = aColor;
          vAlpha = aAlpha;
          vRot = aRot;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRot;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          vec4 t = texture2D(uMap, p);
          gl_FragColor = vec4(vColor * t.rgb, vAlpha * t.a);
          if (gl_FragColor.a < 0.003) discard;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    // Point sizes are in framebuffer pixels: scale by whichever viewport is drawing.
    this.points.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getCurrentViewport(this.vp);
      mat.uniforms.uScale!.value = this.vp.w / 2;
    };
  }

  spawn(o: Spawn): void {
    if (this.density < 1 && Math.random() > this.density) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos.set([o.x, o.y, o.z], i * 3);
    this.vel.set([o.vx ?? 0, o.vy ?? 0, o.vz ?? 0], i * 3);
    this.st.set([0, o.life, o.size, o.grow ?? o.size, o.alpha, o.drag ?? 0, o.gravity ?? 0, (Math.random() - 0.5) * 1.6], i * 8);
    this.c0.set([o.color.r, o.color.g, o.color.b], i * 3);
    const f = o.fade ?? o.color;
    this.c1.set([f.r, f.g, f.b], i * 3);
    this.rot[i] = Math.random() * Math.PI * 2;
    this.alpha[i] = 0.0001;
  }

  update(dt: number, wind: Vector3): void {
    let live = false;
    for (let i = 0; i < this.n; i++) {
      if (this.alpha[i]! <= 0) continue;
      const s = i * 8;
      const age = (this.st[s] = this.st[s]! + dt);
      const life = this.st[s + 1]!;
      if (age >= life) {
        this.alpha[i] = 0;
        continue;
      }
      live = true;
      const k = age / life;
      const drag = Math.exp(-this.st[s + 5]! * dt);
      const v = i * 3;
      this.vel[v] = this.vel[v]! * drag + wind.x * dt;
      this.vel[v + 1] = this.vel[v + 1]! * drag - this.st[s + 6]! * dt;
      this.vel[v + 2] = this.vel[v + 2]! * drag + wind.z * dt;
      this.pos[v] = this.pos[v]! + this.vel[v]! * dt;
      this.pos[v + 1] = Math.max(0.4, this.pos[v + 1]! + this.vel[v + 1]! * dt);
      this.pos[v + 2] = this.pos[v + 2]! + this.vel[v + 2]! * dt;
      this.size[i] = this.st[s + 2]! + (this.st[s + 3]! - this.st[s + 2]!) * (1 - (1 - k) * (1 - k));
      // Quick fade in, long fade out.
      this.alpha[i] = this.st[s + 4]! * Math.min(1, k * 12) * (1 - k) * (1 - k * 0.3);
      this.rot[i] = this.rot[i]! + this.st[s + 7]! * dt;
      for (let c = 0; c < 3; c++) this.col[v + c] = this.c0[v + c]! + (this.c1[v + c]! - this.c0[v + c]!) * Math.min(1, k * 1.6);
    }
    // Upload only while particles are alive, plus the frame that retires the last of them.
    if (live || this.wasLive) {
      for (const name of ["position", "aColor", "aSize", "aAlpha", "aRot"]) this.geom.attributes[name]!.needsUpdate = true;
    }
    this.wasLive = live;
  }

  clear(): void {
    this.alpha.fill(0);
    this.geom.attributes.aAlpha!.needsUpdate = true;
  }
}

interface Shard {
  p: Vector3;
  v: Vector3;
  r: Vector3;
  w: Vector3;
  s: number;
  age: number;
  life: number;
}

interface Ring {
  mesh: Mesh;
  /** Negative while waiting to start. */
  age: number;
  life: number;
  /** Radius at the start and end of its life. */
  from: number;
  to: number;
  opacity: number;
}

interface Plume {
  x: number;
  y: number;
  z: number;
  r: number;
  start: number;
  until: number;
  fireUntil: number;
  next: number;
}

const FIRE = new Color(0xffd27a);
const EMBER = new Color(0xff5a1f);
// Smoke billows out dark (it reads over the grey roofs) and thins to a light
// grey (which reads over the dark ground).
const SMOKE = new Color(0x1c1e20);
const SMOKE_LIGHT = new Color(0x7a7f82);
const DUST = new Color(0x7d766c);

export class Fx {
  readonly group = new Group();
  private readonly fire: Layer;
  private readonly smoke: Layer;
  private readonly shards: Shard[] = [];
  private readonly debris: InstancedMesh;
  /** Broken concrete left on each ruin. */
  private readonly rubbleMesh: InstancedMesh;
  private rubbleCount = 0;
  private readonly rings: Ring[] = [];
  private readonly plumes: Plume[] = [];
  private readonly decals = new Group();
  private readonly scorchMap = scorchTexture();
  private readonly flash = new PointLight(0xffa860, 0, 1, 1.4);
  private flashLevel = 0;
  private readonly wind = new Vector3(3, 0, -1.5);
  private readonly tmp = new Object3D();
  private time = 0;
  /** World size of a typical building; effects scale with it. */
  private unit = 1;
  /** Off: no explosions, smoke or sparks. Rubble and scorch marks stay, since they show what's been demolished. */
  private on = true;

  constructor() {
    this.smoke = new Layer(1400, puffTexture(), false);
    this.fire = new Layer(1400, glowTexture(), true);
    this.debris = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial({ color: 0x4a4744 }), 360);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    this.debris.castShadow = false;
    this.rubbleMesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial({ color: 0x3b3936, flatShading: true }), 900);
    this.rubbleMesh.count = 0;
    this.rubbleMesh.frustumCulled = false;
    this.group.add(this.decals, this.smoke.points, this.fire.points, this.debris, this.rubbleMesh, this.flash);
  }

  /** The effects setting: how many particles to draw, or none. */
  setLevel(level: EffectsLevel): void {
    this.on = level !== "off";
    const density = { off: 0, low: 0.35, medium: 0.65, high: 1 }[level];
    this.fire.density = this.smoke.density = density;
  }

  setScale(unit: number): void {
    this.unit = unit;
    this.flash.distance = 40 * unit;
  }

  /** Forget everything (the city was rebuilt). */
  clear(): void {
    this.fire.clear();
    this.smoke.clear();
    this.shards.length = 0;
    this.debris.count = 0;
    this.rubbleCount = this.rubbleMesh.count = 0;
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      r.mesh.geometry.dispose();
      (r.mesh.material as MeshBasicMaterial).dispose();
    }
    this.rings.length = 0;
    this.plumes.length = 0;
    for (const d of [...this.decals.children]) {
      this.decals.remove(d);
      (d as Mesh).geometry.dispose();
      ((d as Mesh).material as MeshBasicMaterial).dispose();
    }
  }

  /** A detonation. `size` is roughly the fireball radius in world units. */
  explosion(x: number, y: number, z: number, size: number, big: boolean): void {
    if (!this.on) return;
    const u = size;
    this.flashAt(x, y + u, z, big ? 1 : 0.4);
    this.fire.spawn({ x, y: y + u * 0.4, z, life: 0.16, size: u * 3, grow: u * 3.8, color: new Color(0xfff4d8), alpha: 1 });
    const n = big ? 34 : 9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.3 + Math.random() * 0.9;
      const sp = u * (1.5 + Math.random() * 3.2);
      this.fire.spawn({
        x: x + Math.cos(a) * u * 0.3,
        y: y + u * 0.2,
        z: z + Math.sin(a) * u * 0.3,
        vx: Math.cos(a) * sp * (1 - up * 0.5),
        vy: sp * up,
        vz: Math.sin(a) * sp * (1 - up * 0.5),
        life: 0.6 + Math.random() * 0.8,
        size: u * (0.8 + Math.random() * 0.6),
        grow: u * (2 + Math.random() * 1.2),
        color: FIRE,
        fade: EMBER,
        alpha: 0.95,
        drag: 3.2,
        gravity: -u * 1.2,
      });
    }
    // Sparks.
    for (let i = 0; i < (big ? 40 : 12); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = u * (5 + Math.random() * 9);
      const up = 0.4 + Math.random();
      this.fire.spawn({
        x,
        y: y + u * 0.3,
        z,
        vx: Math.cos(a) * sp,
        vy: sp * up,
        vz: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.9,
        size: u * 0.22,
        grow: u * 0.08,
        color: new Color(0xffe9a8),
        fade: EMBER,
        alpha: 1,
        drag: 1.2,
        gravity: u * 14,
      });
    }
    // Smoke rolling out of the fireball.
    for (let i = 0; i < (big ? 30 : 8); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = u * (0.8 + Math.random() * 2.2);
      this.smoke.spawn({
        x: x + Math.cos(a) * u * 0.5,
        y: y + u * (0.3 + Math.random() * 0.8),
        z: z + Math.sin(a) * u * 0.5,
        vx: Math.cos(a) * sp,
        vy: u * (0.8 + Math.random() * 1.6),
        vz: Math.sin(a) * sp,
        life: 4 + Math.random() * 4,
        size: u * 1.4,
        grow: u * (3.5 + Math.random() * 2.5),
        color: new Color(0x16130f),
        fade: SMOKE_LIGHT,
        alpha: 0.9,
        drag: 0.9,
      });
    }
    this.ring(x, z, u * (big ? 4.5 : 2), big ? 0.55 : 0.35);
    if (big) this.shrapnel(x, y + u * 0.3, z, u, 22);
  }

  /** A gun firing: a quick flash at the muzzle. */
  muzzle(p: Vector3, size: number): void {
    if (!this.on) return;
    const u = size * this.unit;
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.07, size: u * 1.6, grow: u * 2.2, color: new Color(0xfff1c4), alpha: 1 });
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.16, size: u, grow: u * 0.4, color: FIRE, fade: EMBER, alpha: 0.8 });
  }

  /** A missile's motor: a glow and a puff of the smoke trail it leaves. */
  trail(p: Vector3): void {
    if (!this.on) return;
    const u = this.unit;
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.08, size: u * 1.4, grow: u * 0.6, color: new Color(0xffe2a0), fade: EMBER, alpha: 0.9 });
    this.smoke.spawn({ x: p.x, y: p.y, z: p.z, vy: u * 0.3, life: 1.6 + Math.random() * 0.8, size: u * 0.9, grow: u * 2.6, color: new Color(0xb8bec2), fade: SMOKE_LIGHT, alpha: 0.55, drag: 1.2 });
  }

  /** A round hitting: a flash, sparks and a puff, scaled by the shell. `heavy` adds a shockwave. */
  impact(p: Vector3, size: number, heavy: boolean): void {
    if (!this.on) return;
    const u = size * this.unit;
    if (size >= 2) this.flashAt(p.x, p.y + u, p.z, Math.min(0.6, size * 0.12));
    this.fire.spawn({ x: p.x, y: p.y + u * 0.3, z: p.z, life: 0.12 + size * 0.04, size: u * 1.8, grow: u * 2.6, color: new Color(0xfff0c8), fade: FIRE, alpha: 1 });
    for (let i = 0; i < 2 + Math.round(size * 2); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = u * (2 + Math.random() * 5);
      this.fire.spawn({
        x: p.x,
        y: p.y + u * 0.2,
        z: p.z,
        vx: Math.cos(a) * sp,
        vy: sp * (0.5 + Math.random()),
        vz: Math.sin(a) * sp,
        life: 0.25 + Math.random() * 0.35,
        size: u * 0.35,
        grow: u * 0.1,
        color: new Color(0xffe39a),
        fade: EMBER,
        alpha: 1,
        drag: 1.5,
        gravity: u * 12,
      });
    }
    for (let i = 0; i < 1 + Math.round(size); i++) {
      this.smoke.spawn({
        x: p.x + (Math.random() - 0.5) * u,
        y: p.y + u * 0.4,
        z: p.z + (Math.random() - 0.5) * u,
        vy: u * (0.6 + Math.random()),
        life: 1.2 + size * 0.5 + Math.random(),
        size: u * 0.9,
        grow: u * (2 + size * 0.3),
        color: new Color(0x2a2724),
        fade: SMOKE_LIGHT,
        alpha: 0.6,
        drag: 0.8,
      });
    }
    if (heavy) this.ring(p.x, p.z, u * 2.6, 0.45);
  }

  /** Dust rolling out from the base of a collapsing building. */
  collapseDust(x: number, z: number, w: number, h: number, height: number): void {
    if (!this.on) return;
    const r = Math.max(w, h) / 2;
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + Math.random() * 0.3;
      const sp = r * (0.8 + Math.random() * 1.4);
      this.smoke.spawn({
        x: x + Math.cos(a) * r * 0.8,
        y: 0.6 + Math.random() * height * 0.4,
        z: z + Math.sin(a) * r * 0.8,
        vx: Math.cos(a) * sp,
        vy: r * 0.15,
        vz: Math.sin(a) * sp,
        life: 2.5 + Math.random() * 2.5,
        size: r * 0.7,
        grow: r * (1.8 + Math.random()),
        color: DUST,
        fade: SMOKE_LIGHT,
        alpha: 0.5,
        drag: 1.6,
      });
    }
    this.shrapnel(x, height * 0.5, z, r * 0.5, 12);
  }

  /** Broken concrete scattered over a building's footprint (stays until the city is rebuilt). */
  rubble(x: number, z: number, w: number, h: number): void {
    const s = Math.min(w, h, 8);
    for (let i = 0; i < 12 && this.rubbleCount < 900; i++) {
      const size = s * (0.12 + Math.random() * 0.22);
      this.tmp.position.set(x + (Math.random() - 0.5) * w * 0.9, 0.4 + size * 0.3, z + (Math.random() - 0.5) * h * 0.9);
      this.tmp.rotation.set((Math.random() - 0.5) * 0.8, Math.random() * Math.PI, (Math.random() - 0.5) * 0.8);
      this.tmp.scale.set(size, size * (0.4 + Math.random() * 0.5), size * (0.6 + Math.random() * 0.6));
      this.tmp.updateMatrix();
      this.rubbleMesh.setMatrixAt(this.rubbleCount++, this.tmp.matrix);
    }
    this.rubbleMesh.count = this.rubbleCount;
    this.rubbleMesh.instanceMatrix.needsUpdate = true;
  }

  /** A burnt patch where a building stood. */
  scorch(x: number, z: number, r: number): void {
    const m = new Mesh(new PlaneGeometry(r * 2, r * 2), new MeshBasicMaterial({ map: this.scorchMap, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI;
    m.position.set(x, 0.42, z);
    this.decals.add(m);
  }

  /** Fire and a column of smoke rising from a ruin. */
  smolder(x: number, y: number, z: number, r: number, seconds: number): void {
    if (!this.on) return;
    this.plumes.push({ x, y, z, r, start: this.time, until: this.time + seconds, fireUntil: this.time + seconds * 0.45, next: 0 });
  }

  update(dt: number): void {
    this.time += dt;
    const u = this.unit;
    for (const pl of this.plumes) {
      if (this.time > pl.until || this.time < pl.next) continue;
      pl.next = this.time + 0.1 + Math.random() * 0.08;
      const left = (pl.until - this.time) / (pl.until - pl.start);
      this.smoke.spawn({
        x: pl.x + (Math.random() - 0.5) * pl.r,
        y: pl.y + 0.5,
        z: pl.z + (Math.random() - 0.5) * pl.r,
        vx: (Math.random() - 0.5) * pl.r * 0.2,
        vy: pl.r * (0.6 + Math.random() * 0.5),
        vz: (Math.random() - 0.5) * pl.r * 0.2,
        life: 6 + Math.random() * 4,
        size: pl.r * 0.8,
        grow: pl.r * (3.5 + Math.random() * 1.5),
        color: SMOKE,
        fade: SMOKE_LIGHT,
        alpha: 0.3 + 0.45 * left,
        drag: 0.4,
      });
      if (this.time < pl.fireUntil) {
        for (let f = 0; f < 2; f++) {
          this.fire.spawn({
            x: pl.x + (Math.random() - 0.5) * pl.r * 1.1,
            y: pl.y + 0.3,
            z: pl.z + (Math.random() - 0.5) * pl.r * 1.1,
            vy: pl.r * (0.5 + Math.random() * 0.6),
            life: 0.6 + Math.random() * 0.5,
            size: pl.r * (0.5 + Math.random() * 0.45),
            grow: pl.r * 0.15,
            color: FIRE,
            fade: EMBER,
            alpha: 0.9,
          });
        }
      }
    }
    for (let i = this.plumes.length - 1; i >= 0; i--) if (this.time > this.plumes[i]!.until) this.plumes.splice(i, 1);

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.age += dt;
      r.mesh.visible = r.age >= 0;
      if (r.age < 0) continue;
      const k = r.age / r.life;
      if (k >= 1) {
        this.group.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as MeshBasicMaterial).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - k) ** 3;
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      (r.mesh.material as MeshBasicMaterial).opacity = r.opacity * (1 - k) * (1 - k);
    }

    // Debris: ballistic, tumbling, settling on the ground, then sinking away.
    let n = 0;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.age += dt;
      if (s.age > s.life) {
        this.shards.splice(i, 1);
        continue;
      }
      if (s.p.y > 0.4 + s.s / 2 || s.v.y > 0) {
        s.v.y -= 30 * u * dt;
        s.p.addScaledVector(s.v, dt);
        s.r.addScaledVector(s.w, dt);
        if (s.p.y < 0.4 + s.s / 2) {
          s.p.y = 0.4 + s.s / 2;
          s.v.multiplyScalar(0.25);
          s.v.y = -s.v.y * 0.3;
          s.w.multiplyScalar(0.3);
        }
      }
      const shrink = Math.min(1, (s.life - s.age) / 1.5);
      this.tmp.position.copy(s.p);
      this.tmp.rotation.set(s.r.x, s.r.y, s.r.z);
      this.tmp.scale.setScalar(s.s * shrink);
      this.tmp.updateMatrix();
      this.debris.setMatrixAt(n++, this.tmp.matrix);
    }
    this.debris.count = n;
    if (n) this.debris.instanceMatrix.needsUpdate = true;

    this.flashLevel = Math.max(0, this.flashLevel - dt * 4.5);
    this.flash.intensity = this.flashLevel * this.flashLevel * 140 * u;

    this.fire.update(dt, this.wind.clone().multiplyScalar(u * 0.3));
    this.smoke.update(dt, this.wind.clone().multiplyScalar(u));
  }

  private flashAt(x: number, y: number, z: number, level: number): void {
    this.flash.position.set(x, y, z);
    this.flashLevel = Math.max(this.flashLevel, level);
  }

  private ring(x: number, z: number, size: number, life: number): void {
    const mesh = new Mesh(new RingGeometry(0.9, 1, 48), new MeshBasicMaterial({ color: 0xffd7a8, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.6, z);
    this.group.add(mesh);
    this.rings.push({ mesh, age: 0, life, from: size * 0.08, to: size * 1.08, opacity: 0.45 });
  }

  /**
   * A ping: rings ripple out from (x, z) at height `y`, drawn over everything
   * like a HUD marker so the city can't hide them.
   */
  ripple(x: number, y: number, z: number, radius: number, color: number): void {
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(
        new RingGeometry(0.95, 1, 64),
        new MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y, z);
      mesh.renderOrder = 10;
      mesh.visible = false;
      this.group.add(mesh);
      // Slow, faint rings a beat apart.
      this.rings.push({ mesh, age: -i * 0.7, life: 2.4, from: radius, to: radius + 20 * this.unit, opacity: 0.5 });
    }
  }

  private shrapnel(x: number, y: number, z: number, u: number, count: number): void {
    for (let i = 0; i < count && this.shards.length < 360; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = u * (1 + Math.random() * 3.2);
      this.shards.push({
        p: new Vector3(x, y, z),
        v: new Vector3(Math.cos(a) * sp, u * (2.5 + Math.random() * 5), Math.sin(a) * sp),
        r: new Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        w: new Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
        s: u * (0.05 + Math.random() * 0.12),
        age: 0,
        life: 7 + Math.random() * 5,
      });
    }
  }
}
