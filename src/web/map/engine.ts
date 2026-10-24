// The tactical map: a near-top-down 3D render of the Code City over pixel
// camo, with BF6-style zoom/pan and a secondary "objective camera" view.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Building, CityModel, Point, Rect } from "../../shared/city";
import { AirWing, type StrikeTarget } from "./air";
import { airfieldFor, worldExtent } from "./airfield";
import { createCamoTexture, createContourTexture } from "./camo";

export type ZoneTone = "cyan" | "orange" | "yellow";

export interface Zone {
  key: string;
  rect: Rect;
  tone: ZoneTone;
}

export interface MapEvents {
  onHover(b: Building | null, x: number, y: number): void;
  onClick(b: Building | null, world: { x: number; z: number }, ev: PointerEvent): void;
  onZoom(pct: number): void;
  onFrame(t: number): void;
}

const TONES: Record<ZoneTone, number> = { cyan: 0x73ecf9, orange: 0xf5896b, yellow: 0xe6e873 };
const TILT = (13 * Math.PI) / 180;
const FOV = 28;

const C = {
  terrain: 0x222c32,
  road: 0x56646f,
  block: 0x232d33,
  buildingA: new Color(0x63737f),
  buildingB: new Color(0x7e8e9a),
  roof: 0x55636e,
  tree: new Color(0x26393d),
  treeB: new Color(0x31474b),
  hq: 0x34434e,
  ruin: new Color(0x2a2724),
};

const COLLAPSE_SECONDS = 1.5;
/** How long a pinged building stays lit once nothing is holding the ping. */
const PING_MS = 15_000;

interface Ruin {
  /** Seconds into the collapse. */
  t: number;
  /** Footprint and height of the intact instance. */
  x: number;
  bottom: number;
  z: number;
  w: number;
  height: number;
  d: number;
  tilt: Vector3;
  from: Color;
  settled: boolean;
}

function shapeFrom(points: Point[]): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, -y) : s.lineTo(x, -y)));
  s.closePath();
  return s;
}

/** Flat ribbon along a polyline, in the XZ plane. */
function ribbon(points: Point[], width: number, closed: boolean, y: number): BufferGeometry {
  const pts = closed ? [...points, points[0]!, points[1]!] : points;
  const pos: number[] = [];
  const half = width / 2;
  const offsets: [number, number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const [x, z] = pts[i]!;
    offsets.push([x - dz * half, z + dx * half, x + dz * half, z - dx * half]);
  }
  for (let i = 0; i < offsets.length - 1; i++) {
    const [ax, az, bx, bz] = offsets[i]!;
    const [cx, cz, dx2, dz2] = offsets[i + 1]!;
    pos.push(ax, y, az, bx, y, bz, cx, y, cz, bx, y, bz, dx2, y, dz2, cx, y, cz);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

function lineGeom(points: Point[], y: number, closed: boolean): LineGeometry {
  const flat: number[] = [];
  for (const [x, z] of points) flat.push(x, y, z);
  if (closed && points.length) flat.push(points[0]![0], y, points[0]![1]);
  const g = new LineGeometry();
  g.setPositions(flat);
  return g;
}

export class WarMap {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 1, 40000);
  private readonly camCam = new PerspectiveCamera(34, 1.6, 1, 4000);
  private readonly ray = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private cityGroup = new Group();
  private zoneGroup = new Group();
  private lineMaterials: LineMaterial[] = [];
  private buildingMesh: InstancedMesh | null = null;
  private instanceToBuilding: number[] = [];
  private baseColors: Color[] = [];
  private highlighted = new Map<number, ZoneTone>();
  private city: CityModel | null = null;
  private readonly camo = createCamoTexture();
  private readonly contour = createContourTexture();
  private readonly sun = new DirectionalLight(0xfffaf2, 2.1);
  /** Aircraft, airlifts and strikes. */
  readonly air = new AirWing();
  private roofMesh: InstancedMesh | null = null;
  /** Instances per building path (a building and its tower). */
  private instancesOf = new Map<string, number[]>();
  /** Collapsing instances. */
  private ruins = new Map<number, Ruin>();
  /** Buildings down (or coming down). */
  private ruined = new Set<string>();
  /** Strike inbound: still standing until the round lands. */
  private doomed = new Set<string>();
  private shake = 0;
  private shadowFrame = 0;
  /** Buildings agents are working on, and their tones. */
  private agentTones = new Map<string, ZoneTone>();
  /** The building the Commander last pinged; `held` while its objective is being written. */
  private pinged: { path: string; until: number; held: boolean } | null = null;

  private target = new Vector3();
  private distance = 400;
  private wantTarget = new Vector3();
  private wantDistance = 400;
  private fitDistance = 400;
  private camView: { rect: DOMRect; focus: Vector3 } | null = null;
  private raf = 0;
  private last = performance.now();
  private width = 1;
  private height = 1;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private resizeObserver: ResizeObserver;
  private lastZoomPct = -1;
  private readonly listeners = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: MapEvents,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(0x0a1218);

    // Cool sky fill + a strong low sun: bright roofs, dark faces and long shadows.
    this.scene.add(new HemisphereLight(0xc3d3df, 0x0a1115, 0.85));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.cityGroup, this.zoneGroup, this.air.group);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.bindInput();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }

  // ── City ──────────────────────────────────────────────────────────────────

  setCity(city: CityModel): void {
    const first = this.city === null;
    this.city = city;
    this.scene.remove(this.cityGroup);
    this.cityGroup.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose?.();
    });
    this.lineMaterials = this.lineMaterials.filter((m) => this.zoneGroup.children.some((c) => (c as Line2).material === m));
    const g = new Group();
    const b = city.bounds;
    const cx = b.x + b.w / 2;
    const cz = b.y + b.h / 2;
    const span = Math.max(b.w, b.h);

    // Camo backdrop, world-space so blocks grow as you zoom in (like BF6).
    const size = span * 10;
    const camo = this.camo.clone();
    camo.needsUpdate = true;
    const texelWorld = 2.4;
    camo.repeat.set(size / (256 * texelWorld), size / (256 * texelWorld));
    const ground = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({ map: camo }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.2, cz);
    g.add(ground);

    // Playable terrain inside the boundary.
    const terrainGeom = new ShapeGeometry(shapeFrom(city.boundary));
    terrainGeom.rotateX(-Math.PI / 2);
    const terrain = new Mesh(terrainGeom, new MeshLambertMaterial({ color: C.terrain }));
    terrain.receiveShadow = true;
    g.add(terrain);
    const contour = this.contour.clone();
    contour.needsUpdate = true;
    contour.repeat.set(1 / 140, 1 / 140);
    const contourGeom = terrainGeom.clone();
    const uv = contourGeom.attributes.position!;
    const uvs = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getZ(i);
    }
    contourGeom.setAttribute("uv", new BufferAttribute(uvs, 2));
    const contourMesh = new Mesh(contourGeom, new MeshBasicMaterial({ map: contour, transparent: true, depthWrite: false }));
    contourMesh.position.y = 0.02;
    g.add(contourMesh);

    // Road base under the city; blocks sit on top so the gaps read as streets.
    const blocksExtent = city.blocks.reduce(
      (acc, bl) => ({
        x0: Math.min(acc.x0, bl.rect.x),
        z0: Math.min(acc.z0, bl.rect.y),
        x1: Math.max(acc.x1, bl.rect.x + bl.rect.w),
        z1: Math.max(acc.z1, bl.rect.y + bl.rect.h),
      }),
      { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity },
    );
    const roadMat = new MeshLambertMaterial({ color: C.road });
    if (Number.isFinite(blocksExtent.x0)) {
      const pad = 3;
      const base = new Mesh(new PlaneGeometry(blocksExtent.x1 - blocksExtent.x0 + pad * 2, blocksExtent.z1 - blocksExtent.z0 + pad * 2), roadMat);
      base.rotation.x = -Math.PI / 2;
      base.position.set((blocksExtent.x0 + blocksExtent.x1) / 2, 0.04, (blocksExtent.z0 + blocksExtent.z1) / 2);
      base.receiveShadow = true;
      g.add(base);
    }
    const ring = new Mesh(ribbon(city.ringRoad, 6, true, 0.05), roadMat);
    ring.receiveShadow = true;
    g.add(ring);
    const hqRoad = new Mesh(ribbon(city.hq.road, 5, false, 0.05), roadMat);
    hqRoad.receiveShadow = true;
    g.add(hqRoad);

    // Block plates.
    const blockGeom = new BoxGeometry(1, 0.3, 1);
    blockGeom.translate(0, 0.15, 0);
    const blocks = new InstancedMesh(blockGeom, new MeshLambertMaterial({ color: 0xffffff }), Math.max(1, city.blocks.length + 1));
    const m = new Matrix4();
    const tmp = new Object3D();
    const blockColor = new Color();
    city.blocks.forEach((bl, i) => {
      tmp.position.set(bl.rect.x + bl.rect.w / 2, 0.05, bl.rect.y + bl.rect.h / 2);
      tmp.scale.set(bl.rect.w, 1, bl.rect.h);
      tmp.updateMatrix();
      blocks.setMatrixAt(i, tmp.matrix);
      blockColor.setHex(C.block).offsetHSL(0, 0, (((i * 37) % 9) - 4) * 0.004);
      blocks.setColorAt(i, blockColor);
    });
    // HQ pad
    const hq = city.hq.rect;
    tmp.position.set(hq.x + hq.w / 2, 0.05, hq.y + hq.h / 2);
    tmp.scale.set(hq.w, 1, hq.h);
    tmp.updateMatrix();
    blocks.setMatrixAt(city.blocks.length, tmp.matrix);
    blocks.setColorAt(city.blocks.length, blockColor.setHex(C.hq));
    blocks.count = city.blocks.length + 1;
    blocks.receiveShadow = true;
    g.add(blocks);

    // Buildings (+ towers) as one instanced mesh.
    const boxGeom = new BoxGeometry(1, 1, 1);
    boxGeom.translate(0, 0.5, 0);
    const instances = city.buildings.length + city.buildings.filter((x) => x.tower).length;
    const bmesh = new InstancedMesh(boxGeom, new MeshLambertMaterial({ color: 0xffffff }), Math.max(1, instances));
    this.instanceToBuilding = [];
    this.baseColors = [];
    this.instancesOf = new Map();
    this.ruins.clear();
    this.ruined.clear();
    this.doomed.clear();
    let k = 0;
    const col = new Color();
    city.buildings.forEach((bd, i) => {
      const put = (x: number, y: number, w: number, h: number, base: number, height: number, shade: number) => {
        tmp.position.set(x + w / 2, base + 0.35, y + h / 2);
        tmp.scale.set(w, Math.max(0.5, height), h);
        tmp.updateMatrix();
        bmesh.setMatrixAt(k, tmp.matrix);
        col.copy(C.buildingA).lerp(C.buildingB, shade);
        if (bd.path.startsWith("@hq")) col.setHex(0x617482);
        else if (bd.path.startsWith("@decor")) col.multiplyScalar(0.86);
        bmesh.setColorAt(k, col);
        this.baseColors[k] = col.clone();
        this.instanceToBuilding[k] = i;
        const list = this.instancesOf.get(bd.path) ?? [];
        list.push(k);
        this.instancesOf.set(bd.path, list);
        k++;
      };
      put(bd.x, bd.y, bd.w, bd.h, 0, bd.height, bd.shade);
      if (bd.tower) put(bd.tower.x, bd.tower.y, bd.tower.w, bd.tower.h, bd.height, bd.tower.height - bd.height, Math.min(1, bd.shade + 0.15));
    });
    bmesh.count = k;
    bmesh.castShadow = true;
    bmesh.receiveShadow = true;
    this.buildingMesh = bmesh;
    this.highlighted.clear();
    g.add(bmesh);

    // Rooftop clutter.
    this.roofMesh = null;
    if (city.roofs.length) {
      const roofs = new InstancedMesh(boxGeom, new MeshLambertMaterial({ color: C.roof }), city.roofs.length);
      city.roofs.forEach((r, i) => {
        tmp.position.set(r.x + r.w / 2, r.base + 0.35, r.y + r.h / 2);
        tmp.scale.set(r.w, r.height, r.h);
        tmp.updateMatrix();
        roofs.setMatrixAt(i, tmp.matrix);
      });
      roofs.castShadow = true;
      roofs.receiveShadow = true;
      this.roofMesh = roofs;
      g.add(roofs);
    }

    // Trees: dark teal canopies (none on the HQ airfield).
    const clear = airfieldFor(city).clear;
    const treesHere = city.trees.filter((t) => !clear.some((r) => t.x > r.x - t.r && t.x < r.x + r.w + t.r && t.y > r.y - t.r && t.y < r.y + r.h + t.r));
    if (treesHere.length) {
      const treeGeom = new IcosahedronGeometry(1, 1);
      const trees = new InstancedMesh(treeGeom, new MeshLambertMaterial({ color: 0xffffff, flatShading: true }), treesHere.length);
      treesHere.forEach((t, i) => {
        tmp.position.set(t.x, t.r * 0.75, t.y);
        tmp.scale.set(t.r, t.r * 0.85, t.r);
        tmp.rotation.y = (i * 1.7) % Math.PI;
        tmp.updateMatrix();
        trees.setMatrixAt(i, tmp.matrix);
        trees.setColorAt(i, col.copy(C.tree).lerp(C.treeB, ((i * 53) % 10) / 10));
      });
      tmp.rotation.y = 0;
      trees.castShadow = true;
      g.add(trees);
    }

    // Playable-area boundary: thin white line.
    g.add(this.line(city.boundary, 0.6, true, 0xe6ebee, 1.6, 0.9));

    // Friendly HQ zone: cyan outline with a faint glow and fill.
    const zoneFill = new ShapeGeometry(shapeFrom(city.hq.zone));
    zoneFill.rotateX(-Math.PI / 2);
    const fill = new Mesh(zoneFill, new MeshBasicMaterial({ color: TONES.cyan, transparent: true, opacity: 0.06, depthWrite: false, side: DoubleSide }));
    fill.position.y = 0.45;
    g.add(fill);
    g.add(this.line(city.hq.zone, 0.7, true, TONES.cyan, 5, 0.18));
    g.add(this.line(city.hq.zone, 0.75, true, TONES.cyan, 2, 0.95));

    this.cityGroup = g;
    this.scene.add(g);

    // Sun from the north-east so shadows fall to the lower-left, as in BF6. Its shadows cover the airbase too.
    const world = this.extent()!;
    const radius = Math.max(world.w, world.h) * 0.75;
    const sx = world.x + world.w / 2;
    const sz = world.y + world.h / 2;
    this.sun.position.set(sx + radius * 0.5, radius * 1.1, sz - radius * 0.6);
    this.sun.target.position.set(sx, 0, sz);
    const sc = this.sun.shadow.camera;
    sc.left = -radius;
    sc.right = radius;
    sc.top = radius;
    sc.bottom = -radius;
    sc.near = 1;
    sc.far = radius * 4;
    sc.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
    this.air.setCity(city, this.sun.target.position.clone().sub(this.sun.position).normalize());

    this.computeFit();
    if (first) this.resetCamera(true);
  }

  private line(points: Point[], y: number, closed: boolean, color: number, width: number, opacity: number): Line2 {
    const mat = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: false });
    mat.resolution.set(this.width, this.height);
    this.lineMaterials.push(mat);
    const line = new Line2(lineGeom(points, y, closed), mat);
    line.computeLineDistances();
    return line;
  }

  // ── Dynamic overlays ──────────────────────────────────────────────────────

  /** Tint buildings agents are working on (they're also the air wing's targets). */
  setHighlights(paths: Map<string, ZoneTone>): void {
    if (!this.buildingMesh || !this.city) return;
    this.agentTones = paths;
    this.air.setTargets([...paths.keys()].filter((p) => !this.ruined.has(p) && !this.doomed.has(p)).flatMap((p) => this.targetOf(p) ?? []));
    this.applyHighlights();
  }

  /** Ping a building: yellow rings ripple out from it, and it stays lit yellow for a while. */
  ping(path: string): void {
    const t = this.targetOf(path);
    if (!t) return;
    this.pinged = { path, until: performance.now() + PING_MS, held: false };
    this.air.fx.ripple(t.x, t.height + 0.5, t.z, Math.max(t.w, t.h) * 0.6 + 1, TONES.yellow);
    this.applyHighlights();
  }

  /** Keep the ping lit while `path` is the ping being acted on; once let go, it fades after a while. */
  holdPing(path: string | null): void {
    const p = this.pinged;
    if (!p) return;
    if (path === p.path) p.held = true;
    else if (p.held) {
      p.held = false;
      p.until = performance.now() + PING_MS;
    }
  }

  private applyHighlights(): void {
    if (!this.buildingMesh || !this.city) return;
    const paths = new Map(this.agentTones);
    if (this.pinged) paths.set(this.pinged.path, "yellow");
    const next = new Map<number, ZoneTone>();
    for (let k = 0; k < this.instanceToBuilding.length; k++) {
      const bd = this.city.buildings[this.instanceToBuilding[k]!];
      const tone = bd ? paths.get(bd.path) : undefined;
      if (tone) next.set(k, tone);
    }
    for (const k of this.highlighted.keys()) if (!next.has(k)) this.buildingMesh.setColorAt(k, this.baseColors[k]!);
    this.highlighted = next;
    this.buildingMesh.instanceColor!.needsUpdate = true;
  }

  setZones(zones: Zone[]): void {
    for (const child of [...this.zoneGroup.children]) {
      this.zoneGroup.remove(child);
      const l = child as Line2 | Mesh;
      l.geometry.dispose();
      const mat = (l as Line2).material;
      if (mat instanceof LineMaterial) this.lineMaterials = this.lineMaterials.filter((x) => x !== mat);
    }
    for (const z of zones) {
      const r = z.rect;
      const pts: Point[] = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ];
      const fill = new Mesh(new PlaneGeometry(r.w, r.h), new MeshBasicMaterial({ color: TONES[z.tone], transparent: true, opacity: z.tone === "orange" ? 0.12 : 0.06, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(r.x + r.w / 2, 0.5, r.y + r.h / 2);
      this.zoneGroup.add(fill);
      this.zoneGroup.add(this.line(pts, 0.8, true, TONES[z.tone], 5, 0.16));
      this.zoneGroup.add(this.line(pts, 0.85, true, TONES[z.tone], 1.8, 0.95));
    }
  }

  /** Render a close-up "objective camera" into a screen rect (the intel panel's cam box). */
  setCamView(rect: DOMRect | null, focus: { x: number; z: number } | null): void {
    this.camView = rect && focus ? { rect, focus: new Vector3(focus.x, 0, focus.z) } : null;
  }

  // ── Strikes ───────────────────────────────────────────────────────────────

  /** Call the gunship in on these buildings; each comes down when the heavy round lands. */
  strike(paths: string[]): void {
    if (!this.city) return;
    const targets: StrikeTarget[] = [];
    for (const p of paths) {
      const t = this.ruined.has(p) || this.doomed.has(p) ? null : this.targetOf(p);
      if (!t) continue;
      this.doomed.add(p);
      this.air.dropTarget(p);
      targets.push(t);
    }
    this.air.strike(targets, (t) => {
      this.doomed.delete(t.path);
      this.collapse(t.path, true);
      this.shake = Math.min(1, this.shake + 0.7);
    });
  }

  private targetOf(path: string): StrikeTarget | null {
    const b = this.city?.buildings.find((x) => x.path === path);
    return b ? { path, x: b.x + b.w / 2, z: b.y + b.h / 2, w: b.w, h: b.h, height: b.tower ? b.tower.height : b.height } : null;
  }

  /** Buildings destroyed before this page loaded: rubble, no fireworks. */
  setDestroyed(paths: Iterable<string>): void {
    for (const p of paths) if (!this.doomed.has(p)) this.collapse(p, false);
  }

  private collapse(path: string, animate: boolean): void {
    const b = this.city?.buildings.find((x) => x.path === path);
    const ks = this.instancesOf.get(path);
    if (!this.buildingMesh || !this.city || !b || !ks || this.ruined.has(path)) return;
    this.ruined.add(path);
    const m = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    for (const k of ks) {
      this.buildingMesh.getMatrixAt(k, m);
      m.decompose(pos, quat, scl);
      this.ruins.set(k, {
        t: animate ? 0 : COLLAPSE_SECONDS,
        x: pos.x,
        bottom: pos.y,
        z: pos.z,
        w: scl.x,
        height: scl.y,
        d: scl.z,
        tilt: new Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3),
        from: this.baseColors[k]!.clone(),
        settled: false,
      });
    }
    // Rooftop clutter goes down with the building.
    const roofs = this.roofMesh;
    if (roofs) {
      const gone = new Matrix4().makeScale(0, 0, 0);
      this.city.roofs.forEach((r, i) => {
        const rx = r.x + r.w / 2;
        const rz = r.y + r.h / 2;
        if (rx > b.x && rx < b.x + b.w && rz > b.y && rz < b.y + b.h) roofs.setMatrixAt(i, gone);
      });
      roofs.instanceMatrix.needsUpdate = true;
    }
    const cx = b.x + b.w / 2;
    const cz = b.y + b.h / 2;
    const size = Math.max(b.w, b.h, 6);
    if (animate) {
      this.air.fx.collapseDust(cx, cz, size, size, b.tower ? b.tower.height : b.height);
      this.air.fx.smolder(cx, 1, cz, size * 0.45, 45);
    }
    this.air.fx.scorch(cx, cz, size * 0.85 + 3);
    this.air.fx.rubble(cx, cz, Math.max(b.w, 2), Math.max(b.h, 2));
    this.stepRuins(0);
  }

  /** Buildings falling in on themselves: they drop, tilt, spread and char. */
  private stepRuins(dt: number): void {
    const mesh = this.buildingMesh;
    if (!mesh || !this.ruins.size) return;
    const tmp = new Object3D();
    const c = new Color();
    let falling = false;
    let landed = false;
    for (const [k, r] of this.ruins) {
      if (r.settled) continue;
      r.t += dt;
      const p = Math.min(1, r.t / COLLAPSE_SECONDS);
      const e = p * p;
      const f = 1 - e * 0.9;
      const jitter = (1 - p) * 0.25 * Math.min(1, r.t * 8);
      tmp.position.set(r.x + Math.sin(r.t * 47) * jitter, 0.35 + (r.bottom - 0.35) * f, r.z + Math.cos(r.t * 53) * jitter);
      tmp.rotation.set(r.tilt.x * e, 0, r.tilt.z * e);
      tmp.scale.set(r.w * (1 + 0.18 * e), Math.max(0.3, r.height * f), r.d * (1 + 0.18 * e));
      tmp.updateMatrix();
      mesh.setMatrixAt(k, tmp.matrix);
      c.copy(r.from).lerp(C.ruin, Math.min(1, p * 1.4));
      mesh.setColorAt(k, c);
      if (p >= 1) {
        r.settled = true;
        this.baseColors[k] = c.clone();
        landed = true;
      } else falling = true;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    // Shadows follow the collapse (every other frame while it falls).
    if (landed || (falling && this.shadowFrame++ % 2 === 0)) this.renderer.shadowMap.needsUpdate = true;
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  /** The city and the airbase outside it: what the camera frames. */
  private extent(): Rect | null {
    return this.city ? worldExtent(this.city, airfieldFor(this.city)) : null;
  }

  private computeFit(): void {
    const b = this.extent();
    if (!b) return;
    const aspect = this.width / this.height;
    // Whole playable area plus a band of camo, like the deploy screen at 78%.
    const visibleH = Math.max(b.h, b.w / aspect) * 1.16;
    this.fitDistance = visibleH / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  }

  resetCamera(instant = false): void {
    const b = this.extent();
    if (!b) return;
    this.wantTarget.set(b.x + b.w / 2, 0, b.y + b.h / 2 + b.h * 0.02);
    this.wantDistance = this.fitDistance;
    if (instant) {
      this.target.copy(this.wantTarget);
      this.distance = this.wantDistance;
    }
  }

  focus(x: number, z: number, zoomIn = true): void {
    this.wantTarget.set(x, 0, z);
    if (zoomIn) this.wantDistance = Math.min(this.wantDistance, this.fitDistance * 0.45);
  }

  zoomBy(factor: number, sx?: number, sy?: number): void {
    const before = sx !== undefined && sy !== undefined ? this.groundAt(sx, sy) : null;
    const min = this.fitDistance * 0.12;
    const max = this.fitDistance * 1.7;
    const next = Math.min(max, Math.max(min, this.wantDistance * factor));
    if (before) {
      // Keep the point under the cursor fixed while zooming.
      const k = 1 - next / this.wantDistance;
      this.wantTarget.x += (before.x - this.wantTarget.x) * k;
      this.wantTarget.z += (before.z - this.wantTarget.z) * k;
    }
    this.wantDistance = next;
  }

  panBy(dxPx: number, dyPx: number): void {
    const worldPerPx = (2 * this.distance * Math.tan(((FOV / 2) * Math.PI) / 180)) / this.height;
    this.wantTarget.x -= dxPx * worldPerPx;
    this.wantTarget.z -= dyPx * worldPerPx;
    this.clampTarget();
  }

  private clampTarget(): void {
    const b = this.extent();
    if (!b) return;
    const m = Math.max(b.w, b.h) * 0.4;
    this.wantTarget.x = Math.min(b.x + b.w + m, Math.max(b.x - m, this.wantTarget.x));
    this.wantTarget.z = Math.min(b.y + b.h + m, Math.max(b.y - m, this.wantTarget.z));
  }

  get zoomPct(): number {
    return Math.round(((this.fitDistance * 0.78) / this.distance) * 100);
  }

  private placeCamera(cam: PerspectiveCamera, target: Vector3, distance: number, tilt: number): void {
    cam.position.set(target.x, distance * Math.cos(tilt), target.z + distance * Math.sin(tilt));
    cam.lookAt(target);
  }

  // ── Projection & picking ──────────────────────────────────────────────────

  private readonly v = new Vector3();

  /** World → CSS pixels. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    this.v.set(x, y, z).project(this.camera);
    return { x: ((this.v.x + 1) / 2) * this.width, y: ((1 - this.v.y) / 2) * this.height, visible: this.v.z < 1 };
  }

  pxPerWorld(): number {
    return this.height / (2 * this.distance * Math.tan(((FOV / 2) * Math.PI) / 180));
  }

  groundAt(sx: number, sy: number): Vector3 | null {
    const ndc = new Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new Vector3();
    return this.ray.ray.intersectPlane(this.ground, hit) ? hit : null;
  }

  pick(sx: number, sy: number): Building | null {
    if (!this.buildingMesh || !this.city) return null;
    const ndc = new Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.buildingMesh, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const bd = this.city.buildings[this.instanceToBuilding[hit.instanceId]!];
    return bd && !bd.path.startsWith("@") ? bd : null;
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    this.computeFit();
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const k = 1 - Math.exp(-dt * 9);
    this.target.lerp(this.wantTarget, k);
    this.distance += (this.wantDistance - this.distance) * k;
    // A heavy round landing shakes the view a little.
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const amp = this.shake * this.shake * this.distance * 0.006;
    this.placeCamera(this.camera, amp ? this.target.clone().add(new Vector3((Math.random() - 0.5) * amp, 0, (Math.random() - 0.5) * amp)) : this.target, this.distance, TILT);

    this.stepRuins(dt);
    this.air.update(dt, this.pxPerWorld(), this.distance * Math.cos(TILT));
    if (this.pinged && !this.pinged.held && now > this.pinged.until) {
      this.pinged = null;
      this.applyHighlights();
    }

    // Pulse highlighted buildings.
    if (this.buildingMesh && this.highlighted.size) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 260);
      const c = new Color();
      for (const [kIdx, tone] of this.highlighted) {
        if (this.ruins.get(kIdx)?.settled === false) continue;
        c.copy(this.baseColors[kIdx]!).lerp(new Color(TONES[tone]), 0.35 + 0.3 * pulse);
        this.buildingMesh.setColorAt(kIdx, c);
      }
      this.buildingMesh.instanceColor!.needsUpdate = true;
    }

    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.render(this.scene, this.camera);

    if (this.camView) {
      const canvasRect = this.canvas.getBoundingClientRect();
      const { rect, focus } = this.camView;
      const x = rect.left - canvasRect.left;
      const y = this.height - (rect.top - canvasRect.top) - rect.height;
      if (rect.width > 4 && rect.height > 4) {
        this.camCam.aspect = rect.width / rect.height;
        this.camCam.updateProjectionMatrix();
        this.placeCamera(this.camCam, focus, 95, (32 * Math.PI) / 180);
        r.setScissorTest(true);
        r.setScissor(x, y, rect.width, rect.height);
        r.setViewport(x, y, rect.width, rect.height);
        r.render(this.scene, this.camCam);
        r.setScissorTest(false);
        r.setViewport(0, 0, this.width, this.height);
      }
    }

    const pct = this.zoomPct;
    if (pct !== this.lastZoomPct) {
      this.lastZoomPct = pct;
      this.events.onZoom(pct);
      if (import.meta.env.DEV) {
        this.canvas.dataset.cam = JSON.stringify({ w: this.width, h: this.height, fit: Math.round(this.fitDistance), dist: Math.round(this.distance), bounds: this.city?.bounds });
      }
    }
    this.events.onFrame(now);
  };

  private bindInput(): void {
    const c = this.canvas;
    const signal = this.listeners.signal;
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.zoomBy(Math.exp(e.deltaY * 0.0014), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false, signal },
    );
    c.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        c.setPointerCapture(e.pointerId);
        this.drag = { x: e.clientX, y: e.clientY, moved: false };
      },
      { signal },
    );
    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          this.panBy(dx, dy);
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
          c.style.cursor = "grabbing";
        }
        return;
      }
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const b = this.pick(sx, sy);
      c.style.cursor = b ? "pointer" : "default";
      this.events.onHover(b, sx, sy);
    }, { signal });
    c.addEventListener("pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      c.style.cursor = "default";
      if (d && !d.moved) {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const g = this.groundAt(sx, sy);
        this.events.onClick(this.pick(sx, sy), { x: g?.x ?? 0, z: g?.z ?? 0 }, e);
      }
    }, { signal });
    c.addEventListener("pointerleave", () => this.events.onHover(null, 0, 0), { signal });
  }
}

/** Where on the map a repo path lives: its building, else its folder's block or district. */
export function locate(city: CityModel, repoPath: string | null): { x: number; z: number; top: number; building: Building | null } | null {
  if (repoPath === null) return null;
  const p = repoPath.replace(/\/$/, "");
  let cluster: Building | null = null;
  for (const b of city.buildings) {
    if (b.path === p) return { x: b.x + b.w / 2, z: b.y + b.h / 2, top: b.tower ? b.tower.height : b.height, building: b };
    if (b.cluster > 1 && p.startsWith(`${b.path}/`) && (!cluster || b.path.length > cluster.path.length)) cluster = b;
  }
  if (cluster) return { x: cluster.x + cluster.w / 2, z: cluster.y + cluster.h / 2, top: cluster.height, building: cluster };
  let best: Rect | null = null;
  let bestLen = -1;
  for (const bl of city.blocks) {
    if ((p === bl.path || p.startsWith(`${bl.path}/`) || bl.path.startsWith(`${p}/`) || (bl.path === "" && !p.includes("/"))) && bl.path.length > bestLen) {
      best = bl.rect;
      bestLen = bl.path.length;
    }
  }
  const d = city.districts.find((x) => x.path === p);
  const r = best ?? d?.rect ?? null;
  return r ? { x: r.x + r.w / 2, z: r.y + r.h / 2, top: 1, building: null } : null;
}

/** The capture zone for a path: the block (folder) it lives in, padded like a BF6 objective area. */
export function zoneRect(city: CityModel, repoPath: string): Rect | null {
  const isFile = city.buildings.some((b) => b.path === repoPath);
  const dir = isFile ? (repoPath.includes("/") ? repoPath.slice(0, repoPath.lastIndexOf("/")) : "") : repoPath;
  let best: Rect | null = null;
  let bestLen = -1;
  for (const bl of city.blocks) {
    const match = bl.path === dir || (dir.startsWith(`${bl.path}/`) && bl.path !== "") || (bl.path.startsWith(`${dir}/`) && dir !== "");
    if (match && bl.path.length > bestLen) {
      best = bl.rect;
      bestLen = bl.path.length;
    }
  }
  if (!best) return districtRect(city, repoPath);
  return { x: best.x - 1.5, y: best.y - 1.5, w: best.w + 3, h: best.h + 3 };
}

/** The top-level district rect for a path. */
export function districtRect(city: CityModel, repoPath: string): Rect | null {
  const exact = city.districts.find((x) => x.path === repoPath);
  if (exact) return exact.rect;
  const top = repoPath.includes("/") ? repoPath.split("/")[0]! : "";
  return city.districts.find((x) => x.path === top)?.rect ?? null;
}
