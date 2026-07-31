/**
 * Side-quest scoring: a deterministic blend of the operators' interest
 * weights and the source's popularity signal. Pure functions, no I/O; every
 * sort tie-breaks on id so identical inputs always produce identical plans.
 */

export const INTEREST_CATEGORIES = ["hike", "boulder", "bike", "scenic", "campground", "family"] as const;

export interface ScorablePoi {
  id: number;
  category: string;
  popularity: number | null;
}

const W_INTEREST = 0.6;
const W_POPULARITY = 0.4;

/**
 * Category-median popularity as the fallback for places with no signal —
 * honest about sparsity without zeroing out whole sources.
 */
export function popularityFallbacks(pois: ScorablePoi[]): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of pois) {
    if (p.popularity === null) continue;
    const list = byCat.get(p.category) ?? [];
    list.push(p.popularity);
    byCat.set(p.category, list);
  }
  const medians = new Map<string, number>();
  for (const [cat, values] of byCat) {
    const sorted = [...values].sort((a, b) => a - b);
    medians.set(cat, sorted[Math.floor(sorted.length / 2)] ?? 0.3);
  }
  return medians;
}

/**
 * Score in [0, ~1]. Returns null for excluded places: a zero-weighted
 * category produces no side-quest suggestions no matter how popular.
 */
export function scorePoi(
  poi: ScorablePoi,
  weights: Map<string, number>,
  fallbacks: Map<string, number>,
): number | null {
  const weight = weights.get(poi.category) ?? 1;
  if (weight <= 0) return null;
  const normWeight = Math.min(weight, 2) / 2;
  const popularity = poi.popularity ?? fallbacks.get(poi.category) ?? 0.3;
  return W_INTEREST * normWeight + W_POPULARITY * popularity;
}

/** Stable ordering: score desc, then id asc — never reshuffles on ties. */
export function byScoreThenId<T extends { score: number; id: number }>(a: T, b: T): number {
  return b.score - a.score || a.id - b.id;
}

/** Yesterday's selected-but-unvisited stops evolve into today's plan. */
export const STICKY_BONUS = 1.5;
