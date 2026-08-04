import type { PoiRecord, PoiRegion, PoiSourceAdapter } from "../types.js";

/**
 * OSM via the Overpass API — the keyless backbone source for logistics POIs:
 * fuel, water, dump stations, laundromats, groceries, campgrounds, restrooms,
 * viewpoints, charging. One combined query per region, capped result size,
 * default public endpoint (be polite: the vertical's refresh cadence should be
 * daily-ish per region, never per-request).
 */

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** tag-match rules, first hit wins. */
const CATEGORY_RULES: { category: string; fallbackName: string; match: (t: Record<string, string>) => boolean }[] = [
  { category: "fuel", fallbackName: "Fuel station", match: (t) => t.amenity === "fuel" },
  { category: "dump-station", fallbackName: "Sanitary dump station", match: (t) => t.amenity === "sanitary_dump_station" },
  { category: "water-fill", fallbackName: "Drinking water", match: (t) => t.amenity === "drinking_water" || t.man_made === "water_point" },
  { category: "laundry", fallbackName: "Laundromat", match: (t) => t.shop === "laundry" },
  { category: "grocery", fallbackName: "Grocery store", match: (t) => t.shop === "supermarket" || t.shop === "convenience" },
  // Dispersed must be tested before campground: an undeveloped backcountry site
  // is tagged tourism=camp_site too, and the first rule to match wins.
  {
    category: "dispersed",
    fallbackName: "Dispersed campsite",
    match: (t) =>
      t.tourism === "camp_site" &&
      (t.backcountry === "yes" || t.camp_site === "basic" || t.informal === "yes"),
  },
  { category: "campground", fallbackName: "Campground", match: (t) => t.tourism === "camp_site" },
  { category: "lodging", fallbackName: "Hotel", match: (t) => t.tourism === "hotel" || t.tourism === "motel" },
  // Overnight parking is the one stay kind where recall must lose to precision.
  // Most amenity=parking is day-use, and a lot that turns out to be posted costs
  // a knock on the window at 2am — so nothing qualifies without a tag that
  // explicitly permits staying the night.
  {
    category: "parking",
    fallbackName: "Overnight parking",
    match: (t) =>
      (t.amenity === "parking" || t.highway === "rest_area") &&
      (t.overnight === "yes" || t.motorhome === "yes" || t.caravan === "yes"),
  },
  { category: "restroom", fallbackName: "Public restroom", match: (t) => t.amenity === "toilets" },
  { category: "scenic", fallbackName: "Viewpoint", match: (t) => t.tourism === "viewpoint" },
  { category: "ev-charge", fallbackName: "Charging station", match: (t) => t.amenity === "charging_station" },
];

function buildQuery(bbox: [number, number, number, number]): string {
  const bb = bbox.join(",");
  const selectors = [
    `node["amenity"~"^(fuel|sanitary_dump_station|drinking_water|toilets|charging_station)$"](${bb});`,
    `way["amenity"~"^(fuel|sanitary_dump_station)$"](${bb});`,
    `node["man_made"="water_point"](${bb});`,
    `node["shop"~"^(laundry|supermarket|convenience)$"](${bb});`,
    `way["shop"="supermarket"](${bb});`,
    `node["tourism"~"^(camp_site|viewpoint|hotel|motel)$"](${bb});`,
    `way["tourism"~"^(camp_site|hotel|motel)$"](${bb});`,
    // Only lots that say overnight is allowed — see the parking rule above.
    `node["amenity"="parking"]["overnight"="yes"](${bb});`,
    `way["amenity"="parking"]["overnight"="yes"](${bb});`,
    `node["amenity"="parking"]["motorhome"="yes"](${bb});`,
    `way["amenity"="parking"]["motorhome"="yes"](${bb});`,
    `node["highway"="rest_area"]["overnight"="yes"](${bb});`,
    `way["highway"="rest_area"]["overnight"="yes"](${bb});`,
  ];
  return `[out:json][timeout:90];(${selectors.join("")});out center 4000;`;
}

export function elementToRecord(el: OverpassElement): PoiRecord | null {
  const tags = el.tags ?? {};
  const rule = CATEGORY_RULES.find((r) => r.match(tags));
  if (!rule) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return null;
  return {
    source: "overpass",
    sourceId: `${el.type}/${String(el.id)}`,
    name: tags.name ?? rule.fallbackName,
    category: rule.category,
    subcategory: tags.amenity ?? tags.shop ?? tags.tourism ?? null,
    lat,
    lng,
    popularity: null,
    tags,
    url: `https://www.openstreetmap.org/${el.type}/${String(el.id)}`,
  };
}

/**
 * Overpass's usage policy expects clients to identify themselves, and the
 * public endpoint enforces it: a request with no User-Agent is answered with
 * 406 Not Acceptable, every time. Node's fetch sends none by default, so this
 * header is what makes the source work at all — not a nicety.
 */
const USER_AGENT = "dilly-dally-poi-sources/0.1.0";

export function createOverpassAdapter(opts?: { endpoint?: string; userAgent?: string }): PoiSourceAdapter {
  const endpoint = opts?.endpoint ?? "https://overpass-api.de/api/interpreter";
  const userAgent = opts?.userAgent ?? USER_AGENT;
  return {
    source: "overpass",
    async fetchRegion(region: PoiRegion) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: `data=${encodeURIComponent(buildQuery(region.bbox))}`,
      });
      if (!res.ok) {
        throw new Error(`Overpass responded ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as { elements?: OverpassElement[] };
      const records: PoiRecord[] = [];
      for (const el of data.elements ?? []) {
        const rec = elementToRecord(el);
        if (rec) records.push(rec);
      }
      return records;
    },
  };
}
