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

/**
 * The four kinds of place the night can be spent in.
 *
 * Kept as one green-through-slate family rather than four unrelated hues,
 * because on the map they answer the same question — "could we sleep here?" —
 * and only differ in what kind of night it would be. Campground keeps the green
 * it has always had; dispersed sits beside it in a deeper, less civic green;
 * lodging takes indigo, and overnight parking the most muted of the four, which
 * is also the honest ranking of how much anyone wants to end up in one.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  campground: "#16a34a",
  dispersed: "#047857",
  lodging: "#4f46e5",
  parking: "#57534e",
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
  dispersed: "Dispersed camping",
  lodging: "Hotel / motel",
  parking: "Overnight parking",
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
 * Cell signal tiers, worst to best.
 *
 * Ordinals rather than names because the tiles carry numbers: a `match` on an
 * integer is both smaller in the archive and cheaper to evaluate than one on
 * strings, and the ordering is the whole point of the scale.
 *
 * Tier 0 — no service — is deliberately absent from every table here. It draws
 * nothing at all, so a dead zone reads as plain basemap. Painting it grey would
 * put a wash over the map that is indistinguishable from a tile that failed to
 * load, which is the one thing this app's map is careful never to do.
 */
export const SIGNAL_TIERS: number[] = [1, 2, 3, 4];

/**
 * A sequential single-hue ramp, light to dark — sequential because signal is
 * ordered data, and a categorical palette would invite reading "5G" as a
 * different kind of thing rather than as more of the same thing.
 *
 * Greens from ColorBrewer's PRGn, which stay distinguishable under the same
 * deuteranopia and protanopia the role colors are already chosen against.
 */
export const SIGNAL_COLORS: Record<number, string> = {
  1: "#d9f0d3",
  2: "#a6dba0",
  3: "#5aae61",
  4: "#1b7837",
};

/**
 * Keyed identically to SIGNAL_COLORS — the legend walks the tier list, so a
 * tier added to one without the other shows up as a missing label rather than
 * as an unexplained color.
 */
export const SIGNAL_LABELS: Record<number, string> = {
  1: "Weak LTE",
  2: "LTE",
  3: "5G",
  4: "Fast 5G",
};

/**
 * Carriers the overlay can color by, in menu order.
 *
 * `best` leads and is the default: "is there any signal here at all" is the
 * question worth answering before you know whose SIM is in the phone, and it
 * is the only one that stays useful when the van carries two.
 */
export const SIGNAL_CARRIERS: { key: string; label: string }[] = [
  { key: "best", label: "Any carrier" },
  { key: "att", label: "AT&T" },
  { key: "tmo", label: "T-Mobile" },
  { key: "vzw", label: "Verizon" },
];

export const DEFAULT_SIGNAL_CARRIER = "best";

/**
 * Says plainly what the overlay is, because it is modelled coverage the
 * carriers filed with the FCC rather than anything anyone measured — and it is
 * well known to be optimistic. Shown wherever the overlay is.
 */
export const SIGNAL_SOURCE_LABEL = "FCC carrier-reported coverage — modelled, not measured";

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

/** The kinds of stay, in the order the weight sliders present them. */
export const STAY_KIND_ORDER: string[] = ["campground", "dispersed", "lodging", "parking"];

/**
 * What the weight sliders are called on screen. The factor keys are the
 * engine's; these are the words two people would actually use about a night.
 */
export const STAY_FACTOR_LABELS: Record<string, string> = {
  needs: "Clears what's running low",
  proximity: "Stays close to the route",
  signal: "Has cell signal for work",
  legality: "Known to be legal",
  cost: "Cheap",
  sights: "Near something worth seeing",
  freshness: "Recently reported",
};

export function stayWeightLabel(factor: string): string {
  if (factor.startsWith("kind-")) return categoryLabel(factor.slice(5));
  return STAY_FACTOR_LABELS[factor] ?? factor;
}

export function signalColor(tier: number): string {
  return SIGNAL_COLORS[tier] ?? "transparent";
}

export function signalLabel(tier: number): string {
  return SIGNAL_LABELS[tier] ?? "No service";
}

/**
 * Whether a carrier key is one we actually publish a property for. Persisted
 * preferences outlive the palette, so a key retired between releases must not
 * reach a paint expression and silently color the whole map as "no service".
 */
export function isSignalCarrier(key: string): boolean {
  return SIGNAL_CARRIERS.some((c) => c.key === key);
}
