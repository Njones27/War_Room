import { memo } from "react";
import type { Activity } from "../../shared/protocol";
import { ARM_L, ARM_R, BODY, EYES, EYES_CLOSED, GEAR, H, LEGS_A, LEGS_B, PROPS, toRects, W, type Rect } from "./art";
import "./mascot.css";

export type MascotActivity = Activity | "walking";

const PROP_FOR: Partial<Record<MascotActivity, string[]>> = {
  building: ["hammer", "sparks"],
  reading: ["paper"],
  scouting: ["binoculars"],
  commands: ["terminal", "cursor"],
  testing: ["flask", "bubbles"],
  webrecon: ["radio", "waves"],
  directing: ["megaphone", "shout"],
  planning: ["clipboard"],
  reporting: ["report"],
  needs_you: ["alert"],
  error: ["alertRed"],
  thinking: ["dots"],
  asleep: ["zzz"],
};

function Rects({ rects, className }: { rects: Rect[]; className?: string }) {
  return (
    <g className={className}>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
      ))}
    </g>
  );
}

// Pre-compute static layers once.
const BODY_RECTS = toRects(BODY);
const GEAR_RECTS: Record<string, Rect[]> = Object.fromEntries(Object.entries(GEAR).map(([k, layers]) => [k, layers.flatMap((l) => toRects(l))]));
const PROP_RECTS: Record<string, Rect[]> = Object.fromEntries(Object.entries(PROPS).map(([k, layers]) => [k, layers.flatMap((l) => toRects(l))]));

export interface MascotProps {
  accessory: string;
  activity: MascotActivity;
  scale?: number;
  flip?: boolean;
  dim?: boolean;
  title?: string;
}

/** An animated pixel mascot. Activity picks the prop and animation; accessory picks the role gear. */
export const Mascot = memo(function Mascot({ accessory, activity, scale = 2, flip = false, dim = false, title }: MascotProps) {
  const eyesClosed = activity === "asleep" || activity === "offline";
  const props = PROP_FOR[activity] ?? [];
  return (
    <svg
      className={`mascot act-${activity}${dim ? " dim" : ""}`}
      width={W * scale}
      height={H * scale}
      viewBox={`0 0 ${W} ${H}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? `${accessory} mascot, ${activity}`}
      style={flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <g className="m-all">
        <Rects rects={LEGS_A} className="m-legsA" />
        <Rects rects={LEGS_B} className="m-legsB" />
        <g className="m-upper">
          <Rects rects={BODY_RECTS} className="m-body" />
          <Rects rects={eyesClosed ? EYES_CLOSED : EYES} className="m-eyes" />
          <Rects rects={[ARM_L]} className="m-armL" />
          <Rects rects={[ARM_R]} className="m-armR" />
          <Rects rects={GEAR_RECTS[accessory] ?? GEAR_RECTS.beret!} className={`m-gear gear-${accessory}`} />
          {props.map((p) => (
            <Rects key={p} rects={PROP_RECTS[p] ?? []} className={`m-prop p-${p}`} />
          ))}
        </g>
      </g>
    </svg>
  );
});
