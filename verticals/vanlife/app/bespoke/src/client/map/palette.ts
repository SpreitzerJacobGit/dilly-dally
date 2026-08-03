/**
 * Role-tier colors — fixed, colorblind-safe ordering, used identically on
 * the map lines and the candidate cards so map↔list correspondence reads
 * both ways.
 */
export const ROLE_COLORS: Record<string, string> = {
  direct: "#2563eb", // blue
  balanced: "#0d9488", // teal
  scenic: "#d97706", // amber
  "side-quest": "#9333ea", // purple
  max: "#db2777", // magenta
};

export const ROLE_LABELS: Record<string, string> = {
  direct: "Direct",
  balanced: "Balanced",
  scenic: "Scenic",
  "side-quest": "Side quest",
  max: "Full dilly-dally",
};

export const PROJECTED_COLOR = "#9ca3af";

export const CATEGORY_COLORS: Record<string, string> = {
  campground: "#16a34a",
  "water-fill": "#0ea5e9",
  "dump-station": "#78716c",
  laundry: "#8b5cf6",
  grocery: "#f59e0b",
  fuel: "#ef4444",
  "ev-charge": "#eab308",
  restroom: "#94a3b8",
  hike: "#15803d",
  boulder: "#b45309",
  bike: "#0891b2",
  scenic: "#db2777",
  family: "#6366f1",
  other: "#64748b",
};

/**
 * Human-readable names for the place categories. Keyed identically to
 * CATEGORY_COLORS — the legend walks that object's keys, so the two stay in
 * lockstep and a category added to one without the other shows up immediately
 * as a missing label rather than a missing dot.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  campground: "Campground",
  "water-fill": "Water fill",
  "dump-station": "Dump station",
  laundry: "Laundry",
  grocery: "Grocery",
  fuel: "Fuel",
  "ev-charge": "EV charging",
  restroom: "Restroom",
  hike: "Hiking",
  boulder: "Bouldering",
  bike: "Biking",
  scenic: "Scenic",
  family: "Family",
  other: "Other",
};

/** Service categories first, then the interest ones — the order they are declared in. */
export const ALL_CATEGORIES: string[] = Object.keys(CATEGORY_COLORS);

/**
 * Land where dispersed camping is permitted, drawn as a wash under everything else.
 *
 * Deliberately outside the greens, teals and ambers: those are spoken for by the
 * route tiers and the place categories, and a legality wash sitting under a
 * campground dot must not read as more of the same thing. Tan and olive are the
 * two unclaimed families left, and both survive being flattened to ~15% opacity
 * over the basemap.
 *
 * Keyed the way CATEGORY_COLORS is, because the legend walks these keys too.
 */
export const LAND_COLORS: Record<string, string> = {
  blm: "#c2a878", // tan
  usfs: "#7d8c4a", // olive
};

export const LAND_LABELS: Record<string, string> = {
  blm: "BLM open land",
  usfs: "Forest road corridor",
};

export const ALL_LAND_LAYERS: string[] = Object.keys(LAND_COLORS);

export function landColor(layer: string): string {
  return LAND_COLORS[layer] ?? "#64748b";
}

export function landLabel(layer: string): string {
  return LAND_LABELS[layer] ?? layer;
}

export function roleColor(tier: string): string {
  return ROLE_COLORS[tier] ?? "#64748b";
}

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? "#64748b";
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
