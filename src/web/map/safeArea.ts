// The part of the screen the HUD leaves free, so the default map and orbit
// views fit inside it instead of sliding under the panels.

export interface SafeArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const GAP = 16;

/**
 * Free rectangles (as insets in px from each edge of `frame`) around the HUD.
 * The left side can clear the squad panel or sit above it; the right side can
 * clear the supply/comms stack or sit below it. The caller picks the roomiest.
 */
export function measureSafeAreas(frame: DOMRect): SafeArea[] {
  const rect = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  };
  const hints = rect(".hud-hints");
  const panel = rect(".roster-panel");
  const stack = rect(".side-stack");
  const deploy = rect(".deploy-btn");
  const dock = rect(".deploy-dock");
  const top = Math.max(0, ...[rect(".hud-header"), rect(".scorebar"), rect(".faction")].map((r) => (r ? r.bottom : 0))) - frame.top;
  const floor = dock ? frame.bottom - dock.top : 0;

  const lefts = [
    // Beside the squad panel.
    { left: Math.max(hints?.right ?? 0, panel?.right ?? 0) - frame.left, bottom: floor },
    // Above it (roomy when the list is collapsed).
    { left: (hints?.right ?? 0) - frame.left, bottom: Math.max(floor, panel ? frame.bottom - panel.top : 0) },
  ];
  const rights = [
    // Clear of the supply/comms stack.
    { right: frame.right - Math.min(frame.right, stack?.left ?? frame.right, deploy?.left ?? frame.right), top },
    // Below it, clear of DEPLOY.
    { right: frame.right - Math.min(frame.right, deploy?.left ?? frame.right), top: Math.max(top, stack ? stack.bottom - frame.top : 0) },
  ];
  const out: SafeArea[] = [];
  for (const l of lefts)
    for (const r of rights)
      out.push({ left: Math.max(0, l.left) + GAP, right: Math.max(0, r.right) + GAP, top: Math.max(0, r.top) + GAP, bottom: Math.max(0, l.bottom) + GAP });
  return out;
}
