// Low-poly 3D aircraft, built in code (original art, no game assets): the
// F-35A Lightning II, UH-60 Black Hawk, an MQ-9-style UAV and the AC-130 gunship.
// Each model is 1 unit long, nose along +X, up +Y, right wing +Z, and wears
// the friendly light-blue of BF6's map icons.
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Shape,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type AircraftKind = "lightning" | "blackhawk" | "uav" | "gunship";

export interface Aircraft {
  kind: AircraftKind;
  /** The whole airframe; position, rotation and scale are set by the flight code. */
  root: Group;
  /** Spinning parts: [part, axis, rate in turns/sec at full power]. */
  spinners: { part: Object3D; axis: "x" | "y" | "z"; rate: number }[];
  /** Rotor discs (blur) that show as the rotors spool up. */
  discs: Mesh[];
  /** Materials whose opacity fades the aircraft (high flyers near the camera). */
  materials: Material[];
  /** Meshes whose silhouette casts a ground shadow. */
  casters: Mesh[];
  /** Blinking anti-collision beacon. */
  beacon: Mesh;
  /** Natural length in world units at 1× scale. */
  length: number;
}

const HULL = new Color(0x9cc9dc);
const HULL_GLOW = new Color(0x163c4a);
const DARK = 0x22313a;
const GLASS = 0x1a2730;

type Pt = [number, number];

/** A flat part from its outline in the XZ plane (x forward, z right). */
function plate(points: Pt[], thickness: number, y: number): BufferGeometry {
  const s = new Shape();
  points.forEach(([x, z], i) => (i === 0 ? s.moveTo(x, z) : s.lineTo(x, z)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, y + thickness / 2, 0);
  return g;
}

/** A plate and its mirror image across the centreline. */
function mirrored(points: Pt[], thickness: number, y: number): BufferGeometry[] {
  return [plate(points, thickness, y), plate(points.map(([x, z]) => [x, -z] as Pt).reverse(), thickness, y)];
}

/** A vertical fin from its side outline (x forward, y up), at lateral offset z. */
function fin(points: Pt[], thickness: number, z: number, cant = 0): BufferGeometry {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false });
  g.translate(0, 0, -thickness / 2);
  if (cant) {
    // Cant outward about the fin's root.
    const rootY = Math.min(...points.map((p) => p[1]));
    g.translate(0, -rootY, 0);
    g.rotateX(cant);
    g.translate(0, rootY, 0);
  }
  g.translate(0, 0, z);
  return g;
}

interface Section {
  x: number;
  /** Half width (z) and half height (y). */
  w: number;
  h: number;
  /** Centre height. */
  y: number;
}

/** A faceted body lofted through elliptical cross-sections (front to back). */
function loft(sections: Section[], sides = 8, z = 0): BufferGeometry {
  const pos: number[] = [];
  const ring = (s: Section) =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      return [s.x, s.y + Math.sin(a) * s.h, z + Math.cos(a) * s.w] as const;
    });
  const rings = sections.map(ring);
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[]) => pos.push(...a, ...b, ...c);
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r]!;
    const B = rings[r + 1]!;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(A[i]!, A[j]!, B[i]!);
      tri(A[j]!, B[j]!, B[i]!);
    }
  }
  // End caps, facing forward and aft.
  for (const [k, front] of [
    [0, true],
    [rings.length - 1, false],
  ] as const) {
    const R = rings[k]!;
    const s = sections[k]!;
    const c = [s.x, s.y, z] as const;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (front) tri(c, R[j]!, R[i]!);
      else tri(c, R[i]!, R[j]!);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Merge parts into one geometry (positions only; the models are flat-shaded). */
function merge(parts: BufferGeometry[]): BufferGeometry {
  const clean = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== "position") n.deleteAttribute(name);
    return n;
  });
  const g = mergeGeometries(clean)!;
  g.computeVertexNormals();
  return g;
}

function kit() {
  const hull = new MeshLambertMaterial({ color: HULL, emissive: HULL_GLOW, flatShading: true, transparent: true });
  const dark = new MeshLambertMaterial({ color: DARK, flatShading: true, transparent: true });
  const glass = new MeshLambertMaterial({ color: GLASS, emissive: 0x0a1418, flatShading: true, transparent: true });
  const blur = new MeshBasicMaterial({ color: 0xd8eef6, transparent: true, opacity: 0, depthWrite: false, side: DoubleSide });
  const red = new MeshBasicMaterial({ color: 0xff4a3a, transparent: true });
  const green = new MeshBasicMaterial({ color: 0x5dff8a, transparent: true });
  return { hull, dark, glass, blur, red, green };
}

function assemble(kind: AircraftKind, length: number, parts: { hull: BufferGeometry[]; dark: BufferGeometry[]; glass: BufferGeometry[] }, m: ReturnType<typeof kit>, lights: { red: Pt3; green: Pt3; beacon: Pt3 }): Aircraft {
  const root = new Group();
  const casters: Mesh[] = [];
  for (const [geoms, mat] of [
    [parts.hull, m.hull],
    [parts.dark, m.dark],
    [parts.glass, m.glass],
  ] as const) {
    if (!geoms.length) continue;
    const mesh = new Mesh(merge(geoms), mat);
    root.add(mesh);
    casters.push(mesh);
  }
  const light = (p: Pt3, mat: MeshBasicMaterial, s = 0.018) => {
    const l = new Mesh(new BoxGeometry(s, s, s), mat);
    l.position.set(...p);
    root.add(l);
    return l;
  };
  light(lights.red, m.red);
  light(lights.green, m.green);
  const beacon = light(lights.beacon, m.red, 0.024);
  return {
    kind,
    root,
    spinners: [],
    discs: [],
    materials: [m.hull, m.dark, m.glass, m.blur, m.red, m.green],
    casters,
    beacon,
    length,
  };
}

type Pt3 = [number, number, number];

/** Rotor hub with blades turning about `axis`, plus a blur disc. */
function rotor(m: ReturnType<typeof kit>, opts: { blades: number; radius: number; chord: number; axis: "y" | "x" | "z"; at: Pt3 }): { hub: Group; disc: Mesh; blades: Mesh } {
  const hub = new Group();
  hub.position.set(...opts.at);
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < opts.blades; i++) {
    const g = box(opts.radius, opts.chord * 0.18, opts.chord, opts.radius / 2, 0, 0);
    g.rotateY((i / opts.blades) * Math.PI * 2);
    parts.push(g);
  }
  parts.push(box(opts.chord * 1.6, opts.chord * 0.9, opts.chord * 1.6, 0, 0, 0));
  const blades = new Mesh(merge(parts), m.dark);
  const disc = new Mesh(new CircleGeometry(opts.radius, 28), m.blur);
  disc.rotation.x = -Math.PI / 2;
  hub.add(blades, disc);
  // Built spinning about Y; tip the hub for props facing forward or sideways.
  if (opts.axis === "x") hub.rotation.z = -Math.PI / 2;
  if (opts.axis === "z") hub.rotation.x = Math.PI / 2;
  return { hub, disc, blades };
}

export function buildLightning(): Aircraft {
  const m = kit();
  const hull: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  // A shorter, deeper fuselage than the F-22's, widest at the side intakes.
  hull.push(
    loft(
      [
        { x: 0.5, w: 0.004, h: 0.004, y: 0.0 },
        { x: 0.42, w: 0.04, h: 0.03, y: 0.0 },
        { x: 0.3, w: 0.075, h: 0.048, y: 0.008 },
        { x: 0.15, w: 0.125, h: 0.055, y: 0.006 },
        { x: -0.2, w: 0.115, h: 0.052, y: 0.004 },
        { x: -0.36, w: 0.072, h: 0.045, y: 0.004 },
        { x: -0.42, w: 0.05, h: 0.038, y: 0.004 },
      ],
      6,
    ),
  );
  // Trapezoidal wings, swept leading edge and a short tip chord.
  hull.push(
    ...mirrored(
      [
        [0.08, 0.1],
        [-0.15, 0.34],
        [-0.22, 0.34],
        [-0.27, 0.1],
      ],
      0.012,
      -0.004,
    ),
  );
  // Horizontal tails.
  hull.push(
    ...mirrored(
      [
        [-0.3, 0.07],
        [-0.41, 0.215],
        [-0.48, 0.215],
        [-0.48, 0.06],
      ],
      0.01,
      -0.004,
    ),
  );
  // Twin canted fins.
  for (const side of [1, -1]) {
    hull.push(
      fin(
        [
          [-0.24, 0.04],
          [-0.35, 0.16],
          [-0.41, 0.16],
          [-0.42, 0.04],
        ],
        0.01,
        side * 0.072,
        side * 0.42,
      ),
    );
  }
  // Side intakes and the single round nozzle.
  for (const side of [1, -1]) dark.push(box(0.07, 0.045, 0.03, 0.17, -0.004, side * 0.115));
  dark.push(
    loft(
      [
        { x: -0.42, w: 0.04, h: 0.036, y: 0.004 },
        { x: -0.5, w: 0.034, h: 0.032, y: 0.004 },
      ],
      8,
    ),
  );
  // Bubble canopy, gold-tinted.
  glass.push(
    loft(
      [
        { x: 0.37, w: 0.004, h: 0.004, y: 0.035 },
        { x: 0.3, w: 0.03, h: 0.03, y: 0.045 },
        { x: 0.18, w: 0.028, h: 0.026, y: 0.048 },
        { x: 0.1, w: 0.004, h: 0.004, y: 0.045 },
      ],
      6,
    ),
  );
  m.glass.color.setHex(0x3a3320);
  return assemble("lightning", 12.5, { hull, dark, glass }, m, { red: [-0.19, 0.01, -0.34], green: [-0.19, 0.01, 0.34], beacon: [-0.36, 0.16, 0.1] });
}

export function buildBlackhawk(): Aircraft {
  const m = kit();
  const hull: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  hull.push(
    loft(
      [
        { x: 0.44, w: 0.035, h: 0.04, y: 0.03 },
        { x: 0.38, w: 0.075, h: 0.075, y: 0.035 },
        { x: 0.28, w: 0.095, h: 0.1, y: 0.045 },
        { x: -0.08, w: 0.095, h: 0.1, y: 0.045 },
        { x: -0.2, w: 0.06, h: 0.07, y: 0.075 },
        { x: -0.32, w: 0.03, h: 0.035, y: 0.1 },
        { x: -0.62, w: 0.02, h: 0.025, y: 0.115 },
        { x: -0.67, w: 0.015, h: 0.02, y: 0.12 },
      ],
      8,
    ),
  );
  // Engine doghouse.
  hull.push(
    loft(
      [
        { x: 0.18, w: 0.03, h: 0.02, y: 0.14 },
        { x: 0.12, w: 0.07, h: 0.04, y: 0.15 },
        { x: -0.12, w: 0.07, h: 0.04, y: 0.15 },
        { x: -0.2, w: 0.03, h: 0.02, y: 0.14 },
      ],
      6,
    ),
  );
  // Swept tail fin and stabilator.
  hull.push(
    fin(
      [
        [-0.6, 0.1],
        [-0.67, 0.27],
        [-0.72, 0.27],
        [-0.7, 0.1],
      ],
      0.012,
      0,
    ),
  );
  hull.push(
    ...mirrored(
      [
        [-0.62, 0.0],
        [-0.64, 0.12],
        [-0.69, 0.12],
        [-0.69, 0.0],
      ],
      0.008,
      0.11,
    ),
  );
  // Windscreen and cabin windows; wheels.
  glass.push(box(0.07, 0.05, 0.15, 0.37, 0.085, 0));
  for (const side of [1, -1]) {
    glass.push(box(0.12, 0.05, 0.004, 0.1, 0.07, side * 0.096));
    dark.push(box(0.035, 0.035, 0.02, 0.28, -0.06, side * 0.1));
  }
  dark.push(box(0.03, 0.03, 0.02, -0.6, 0.08, 0));
  const ac = assemble("blackhawk", 10.5, { hull, dark, glass }, m, { red: [0.0, 0.04, -0.1], green: [0.0, 0.04, 0.1], beacon: [-0.15, 0.18, 0] });
  const main = rotor(m, { blades: 4, radius: 0.52, chord: 0.03, axis: "y", at: [0.0, 0.2, 0] });
  const tail = rotor(m, { blades: 4, radius: 0.1, chord: 0.012, axis: "z", at: [-0.69, 0.23, 0.02] });
  ac.root.add(main.hub, tail.hub);
  ac.spinners.push({ part: main.blades, axis: "y", rate: 4.2 }, { part: tail.blades, axis: "y", rate: 15 });
  ac.discs.push(main.disc, tail.disc);
  ac.casters.push(main.blades);
  return ac;
}

export function buildUav(): Aircraft {
  const m = kit();
  const hull: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  hull.push(
    loft(
      [
        { x: 0.5, w: 0.02, h: 0.025, y: 0.0 },
        { x: 0.44, w: 0.055, h: 0.06, y: 0.01 },
        { x: 0.3, w: 0.055, h: 0.05, y: 0.0 },
        { x: -0.3, w: 0.035, h: 0.035, y: 0.0 },
        { x: -0.42, w: 0.018, h: 0.02, y: 0.0 },
      ],
      8,
    ),
  );
  // Long straight wings.
  hull.push(
    ...mirrored(
      [
        [0.1, 0.04],
        [0.06, 0.98],
        [0.0, 0.98],
        [-0.04, 0.04],
      ],
      0.01,
      0.02,
    ),
  );
  // V-tail and ventral fin.
  for (const side of [1, -1]) {
    hull.push(
      fin(
        [
          [-0.26, 0.02],
          [-0.37, 0.2],
          [-0.42, 0.2],
          [-0.4, 0.02],
        ],
        0.01,
        side * 0.02,
        side * 0.8,
      ),
    );
  }
  hull.push(
    fin(
      [
        [-0.3, -0.02],
        [-0.36, -0.13],
        [-0.4, -0.13],
        [-0.38, -0.02],
      ],
      0.01,
      0,
    ),
  );
  // Sensor ball under the nose.
  glass.push(
    loft(
      [
        { x: 0.4, w: 0.004, h: 0.004, y: -0.06 },
        { x: 0.37, w: 0.03, h: 0.03, y: -0.06 },
        { x: 0.33, w: 0.03, h: 0.03, y: -0.06 },
        { x: 0.3, w: 0.004, h: 0.004, y: -0.06 },
      ],
      6,
    ),
  );
  dark.push(box(0.03, 0.04, 0.04, -0.43, 0, 0));
  const ac = assemble("uav", 9, { hull, dark, glass }, m, { red: [0.03, 0.03, -0.98], green: [0.03, 0.03, 0.98], beacon: [-0.1, 0.05, 0] });
  const prop = rotor(m, { blades: 3, radius: 0.11, chord: 0.02, axis: "x", at: [-0.45, 0, 0] });
  ac.root.add(prop.hub);
  ac.spinners.push({ part: prop.blades, axis: "y", rate: 12 });
  ac.discs.push(prop.disc);
  return ac;
}

export function buildGunship(): Aircraft {
  const m = kit();
  const hull: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  hull.push(
    loft(
      [
        { x: 0.5, w: 0.025, h: 0.03, y: 0.0 },
        { x: 0.45, w: 0.07, h: 0.07, y: 0.01 },
        { x: 0.37, w: 0.085, h: 0.085, y: 0.02 },
        { x: -0.2, w: 0.085, h: 0.085, y: 0.02 },
        { x: -0.32, w: 0.065, h: 0.06, y: 0.05 },
        { x: -0.46, w: 0.03, h: 0.03, y: 0.09 },
        { x: -0.5, w: 0.015, h: 0.02, y: 0.1 },
      ],
      8,
    ),
  );
  // High straight wing.
  hull.push(
    ...mirrored(
      [
        [0.12, 0.07],
        [0.07, 0.68],
        [-0.02, 0.68],
        [-0.04, 0.07],
      ],
      0.016,
      0.095,
    ),
  );
  // Tail.
  hull.push(
    fin(
      [
        [-0.3, 0.08],
        [-0.43, 0.36],
        [-0.5, 0.36],
        [-0.5, 0.1],
      ],
      0.014,
      0,
    ),
  );
  hull.push(
    ...mirrored(
      [
        [-0.38, 0.0],
        [-0.42, 0.26],
        [-0.49, 0.26],
        [-0.5, 0.0],
      ],
      0.01,
      0.1,
    ),
  );
  // Four engine nacelles.
  const props: Pt3[] = [];
  for (const z of [-0.42, -0.21, 0.21, 0.42]) {
    hull.push(
      loft(
        [
          { x: 0.22, w: 0.018, h: 0.02, y: 0.085 },
          { x: 0.18, w: 0.03, h: 0.032, y: 0.085 },
          { x: 0.0, w: 0.026, h: 0.03, y: 0.09 },
          { x: -0.06, w: 0.01, h: 0.01, y: 0.095 },
        ],
        6,
        z,
      ),
    );
    props.push([0.225, 0.085, z]);
  }
  // Cockpit glass; the port-side guns (the gunship fires left).
  glass.push(box(0.05, 0.04, 0.12, 0.43, 0.06, 0));
  for (const x of [0.12, -0.04, -0.14]) dark.push(box(0.05, 0.022, 0.07, x, 0.0, -0.09));
  const ac = assemble("gunship", 22, { hull, dark, glass }, m, { red: [0.02, 0.1, -0.68], green: [0.02, 0.1, 0.68], beacon: [-0.47, 0.36, 0] });
  for (const p of props) {
    const prop = rotor(m, { blades: 4, radius: 0.075, chord: 0.012, axis: "x", at: p });
    ac.root.add(prop.hub);
    ac.spinners.push({ part: prop.blades, axis: "y", rate: 11 });
    ac.discs.push(prop.disc);
  }
  return ac;
}

export function buildAircraft(kind: AircraftKind): Aircraft {
  switch (kind) {
    case "lightning":
      return buildLightning();
    case "blackhawk":
      return buildBlackhawk();
    case "uav":
      return buildUav();
    case "gunship":
      return buildGunship();
  }
}
