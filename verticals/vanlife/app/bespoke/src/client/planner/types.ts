/**
 * The Target shape the planner works in.
 *
 * Structurally the server's TargetView, restated here so the client components
 * do not import from src/server. tRPC infers the real thing at the query
 * boundary; this is what gets passed around once it has been read.
 */
export interface TargetNode {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
  depth: number;
  orderIndex: number;
  ordinal: number | null;
  final: boolean;
  status: string;
  arriveBy: string | null;
  notes: string | null;
  ring: [number, number][] | null;
  resolved: {
    point: { lat: number; lng: number };
    via: string;
    poiId: number | null;
    poiName: string | null;
    detourMinutes: number;
  } | null;
  pinned: { lat: number; lng: number } | null;
  pacing: { etaDays: number; etaDate: string; horizon: string; behind: boolean } | null;
  children: TargetNode[];
}

export function flattenTargets(nodes: TargetNode[]): TargetNode[] {
  return nodes.flatMap((n) => [n, ...flattenTargets(n.children)]);
}

/** Plain-language account of where the route actually goes and what it costs. */
export function resolutionLine(t: TargetNode): string {
  if (t.final) return "the trip ends here";
  if (t.radiusMiles === 0) return "exact point";
  if (!t.resolved) return "narrowed — routing through the Target below";
  const cost = t.resolved.detourMinutes > 0 ? ` (+${String(t.resolved.detourMinutes)} min)` : "";
  switch (t.resolved.via) {
    case "poi":
      return `routing via ${t.resolved.poiName ?? "a place"}${cost}`;
    case "pinned":
      return `routing via your pinned spot${cost}`;
    case "geometric":
      return `no known place inside — routing through the nearest point${cost}`;
    default:
      return `routing through${cost}`;
  }
}

export function pacingLabel(t: TargetNode): string | null {
  if (!t.pacing) return null;
  return t.pacing.behind ? `behind — ${t.pacing.etaDate}` : `day ${String(t.pacing.etaDays)}`;
}

/** Radius slider stops, so the low end of the range stays usable. */
export const RADIUS_STOPS = [0, 5, 15, 30, 60, 110, 180, 250, 400];

export function nearestStop(miles: number): number {
  let best = 0;
  for (let i = 1; i < RADIUS_STOPS.length; i++) {
    if (Math.abs(RADIUS_STOPS[i]! - miles) < Math.abs(RADIUS_STOPS[best]! - miles)) best = i;
  }
  return best;
}
