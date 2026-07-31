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

export function roleColor(tier: string): string {
  return ROLE_COLORS[tier] ?? "#64748b";
}
