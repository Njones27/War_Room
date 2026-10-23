import { squadOrder, useStore } from "../lib/store";
import { mapRef } from "../map/mapRef";

/** Select an agent (opening its intel panel) and bring it into view. Selecting it again closes the panel. */
export function viewAgent(id: string, toggle = true): void {
  const s = useStore.getState();
  const next = toggle && id === s.selectedAgentId ? null : id;
  s.select(next);
  const pos = next ? mapRef.positions.get(next) : null;
  if (pos) mapRef.map?.focus(pos.x, pos.z, false);
}

/** Q / E: the previous or next agent, in roster order. */
export function cycleAgent(step: 1 | -1): void {
  const s = useStore.getState();
  const list = squadOrder(s.agents);
  if (!list.length) return;
  const i = list.findIndex((a) => a.id === s.selectedAgentId);
  const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length;
  viewAgent(list[next]!.id, false);
}
