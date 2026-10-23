// Pixel art for the mascot: original sprites in the style of the Claude Code
// CLI mascot (block body, two eyes, side arms, four legs). Each layer is a
// list of rows; every character maps to a palette color ('.' = empty).
// The canvas is 22×22; the body sits at the bottom, gear and props on top.

export const W = 22;
export const H = 22;

export const PALETTE: Record<string, string> = {
  O: "#d97757", // body
  o: "#b8604a", // body shade
  h: "#e8906f", // body highlight
  E: "#16171b", // eyes
  K: "#3d4836", // officer cap
  b: "#1d241c",
  v: "#121612",
  G: "#e8c547", // gold
  Y: "#e8b931", // hard hat
  y: "#c4951b",
  H: "#3b4650", // tactical helmet
  j: "#566470",
  S: "#0d0f12", // shades
  c: "#70ebfc", // cyan
  L: "#6b7a3a", // boonie
  l: "#56632e",
  W: "#e9eef0", // white
  w: "#c2cbd0",
  R: "#e04646", // red
  D: "#2a3138", // dark gear
  g: "#9aa4aa", // steel
  n: "#8b5a2b", // wood
  N: "#6e4a28",
  P: "#e8ecef", // paper
  p: "#9aa4aa",
  T: "#0b0f12", // terminal
  t: "#80be75", // green
  f: "#b9c6cd", // glass
  M: "#7c4fd0", // beret
  m: "#5d3aa0",
  X: "#fd8664", // orange
  Z: "#d8dee2",
  A: "#e6e873", // yellow
};

export interface Layer {
  y: number;
  rows: string[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** Merge horizontal runs of the same color into rects. */
export function toRects(layer: Layer, dx = 0, dy = 0): Rect[] {
  const out: Rect[] = [];
  layer.rows.forEach((row, ry) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      if (ch === "." || ch === " ") {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      out.push({ x: x + dx, y: layer.y + ry + dy, w: end - x, h: 1, fill: PALETTE[ch] ?? "#ff00ff" });
      x = end;
    }
  });
  return out;
}

// ── Body ───────────────────────────────────────────────────────────────────

export const BODY: Layer = {
  y: 11,
  rows: [
    "....hhhhhhhhhhhhhh....",
    "....OOOOOOOOOOOOOO....",
    "....OOOOOOOOOOOOOO....",
    "....OOOOOOOOOOOOOO....",
    "....OOOOOOOOOOOOOO....",
    "....OOOOOOOOOOOOOO....",
    "....OOOOOOOOOOOOOO....",
    "....oooooooooooooo....",
  ],
};
export const EYES: Rect[] = [
  { x: 7, y: 13, w: 1, h: 2, fill: PALETTE.E! },
  { x: 14, y: 13, w: 1, h: 2, fill: PALETTE.E! },
];
export const EYES_CLOSED: Rect[] = [
  { x: 6, y: 14, w: 2, h: 1, fill: PALETTE.E! },
  { x: 14, y: 14, w: 2, h: 1, fill: PALETTE.E! },
];
export const ARM_L: Rect = { x: 2, y: 15, w: 2, h: 2, fill: PALETTE.O! };
export const ARM_R: Rect = { x: 18, y: 15, w: 2, h: 2, fill: PALETTE.O! };
export const LEGS_A: Rect[] = [
  { x: 5, y: 19, w: 1, h: 3, fill: PALETTE.O! },
  { x: 14, y: 19, w: 1, h: 3, fill: PALETTE.O! },
];
export const LEGS_B: Rect[] = [
  { x: 7, y: 19, w: 1, h: 3, fill: PALETTE.O! },
  { x: 16, y: 19, w: 1, h: 3, fill: PALETTE.O! },
];

// ── Role gear ──────────────────────────────────────────────────────────────

export const GEAR: Record<string, Layer[]> = {
  "officer-cap": [
    {
      y: 6,
      rows: [
        "......KKKKKKKKKK......",
        ".....KKKKKKKKKKKK.....",
        ".....KKKKKGGKKKKK.....",
        "....bbbbbbbbbbbbbb....",
        "...vvvvvvvvvvvvvvvv...",
      ],
    },
    { y: 16, rows: ["..........GG.........."] },
  ],
  hardhat: [
    {
      y: 6,
      rows: [
        "........YYYYYY........",
        "......YYYYYYYYYY......",
        ".....YYYYYyyYYYYY.....",
        ".....YYYYYyyYYYYY.....",
        "...yyyyyyyyyyyyyyyy...",
      ],
    },
  ],
  helmet: [
    {
      y: 6,
      rows: [
        "......HHHHHHHHHH......",
        ".....HHHHHHHHHHHH.....",
        "....HHHHHHHHHHHHHH....",
        "....HHHHHHHHHHHHHH....",
        "....jjjjjjjjjjjjjj....",
      ],
    },
    { y: 13, rows: ["......SSSSSSSSSS......", "......SSS....SSS......"] },
    { y: 13, rows: [".......c......c......."] },
    { y: 16, rows: ["..........cc..........", "..........cc.........."] },
  ],
  boonie: [
    {
      y: 7,
      rows: [
        ".......LLLLLLLL.......",
        "......LLLLLLLLLL......",
        "......lLlLlLlLlL......",
        "..LLLLLLLLLLLLLLLLLL..",
        "..ll..............ll..",
      ],
    },
  ],
  "medic-helmet": [
    {
      y: 6,
      rows: [
        "......WWWWWWWWWW......",
        ".....WWWWWRRWWWWW.....",
        ".....WWWWRRRRWWWW.....",
        ".....WWWWWRRWWWWW.....",
        "....wwwwwwwwwwwwww....",
      ],
    },
  ],
  headset: [
    { y: 9, rows: ["......DDDDDDDDDD......", ".....D..........D....."] },
    { y: 13, rows: ["...DD............DD...", "...Dc............cD...", "...DD............DD..."] },
    { y: 16, rows: [".....D................", "......DDg............."] },
    { y: 4, rows: ["...................X..", "...................g..", "...................g..", "...................g..", "...................g..", "...................g..", "..................gg.."] },
  ],
  beret: [
    {
      y: 8,
      rows: ["......MMMMMMMMMM......", ".....MMMMMMMMMMMMM....", "....mmmmmmmmmmmmmm...."],
    },
  ],
  none: [],
};

// ── Activity props ─────────────────────────────────────────────────────────

export const PROPS: Record<string, Layer[]> = {
  hammer: [{ y: 8, rows: ["..................ggg.", "..................ggg.", "...................n..", "...................n..", "...................n..", "...................N.."] }],
  sparks: [{ y: 6, rows: ["...................A.A", "....................A.", "...................A.A"] }],
  paper: [
    {
      y: 15,
      rows: ["......PPPPPPPPP.......", "......PpppppppP.......", "......PPPPPPPPP.......", "......PpppppPPP.......", "......PPPPPPPPP......."],
    },
  ],
  binoculars: [{ y: 12, rows: ["......SSSS..SSSS......", "......ScSSSSScSS......", "......SSSS..SSSS......"] }],
  terminal: [
    {
      y: 14,
      rows: ["......PPPPPPPPPP......", "......PTTTTTTTTP......", "......PTtTTTTTTP......", "......PTTtTpppTP......", "......PTtTTTTTTP......", "......PPPPPPPPPP......"],
    },
  ],
  cursor: [{ y: 18, rows: ["........tt............"] }],
  flask: [{ y: 9, rows: ["...................f..", "...................f..", "..................fff.", "..................ftf.", "..................ttt."] }],
  bubbles: [{ y: 5, rows: ["...................t..", "....................t.", "...................t.."] }],
  radio: [{ y: 7, rows: ["....................X.", "....................g.", "....................g.", "...................DD.", "...................DD.", "...................Dc.", "...................DD."] }],
  waves: [{ y: 4, rows: ["....................cc", ".....................c", "....................cc"] }],
  megaphone: [{ y: 12, rows: ["...................WW.", "..................WWWW", "..................RWWW", "...................WW."] }],
  shout: [{ y: 10, rows: ["......................", "....................c.", ".....................c", "....................c."] }],
  clipboard: [
    {
      y: 14,
      rows: ["..........gg..........", ".......NNNNNNNN.......", ".......NPPPPPPN.......", ".......NPtPppPN.......", ".......NPPPPPPN.......", ".......NPtPppPN.......", ".......NNNNNNNN......."],
    },
  ],
  report: [{ y: 6, rows: ["..................PPPP", "..................PppP", "..................PPPP", "..................PppP", "..................PPPP"] }],
  alert: [{ y: 0, rows: ["..........AA..........", "..........AA..........", "..........AA..........", "......................", "..........AA.........."] }],
  alertRed: [{ y: 0, rows: ["..........XX..........", "..........XX..........", "..........XX..........", "......................", "..........XX.........."] }],
  dots: [{ y: 3, rows: ["......ZZ..ZZ..ZZ......", "......ZZ..ZZ..ZZ......"] }],
  zzz: [{ y: 1, rows: ["..................ZZZ.", "...................Z..", "..................ZZZ."] }],
};
