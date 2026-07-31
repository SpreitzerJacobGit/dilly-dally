import type { PoiRecord, PoiRegion, PoiSourceAdapter } from "../types.js";
import { getPoiSourceKeys } from "../settings.js";

/**
 * National Park Service API. No bbox parameter exists, so each fetch pulls the
 * (small, ~500-row) national lists and filters to the region locally. Parks
 * become "scenic" anchors; campgrounds become "campground".
 */

interface NpsPark {
  parkCode: string;
  fullName: string;
  latitude: string;
  longitude: string;
  url: string;
  designation?: string;
}

interface NpsCampground {
  id: string;
  name: string;
  latitude: string;
  longitude: string;
  url?: string;
  parkCode?: string;
}

function inBbox(lat: number, lng: number, [s, w, n, e]: [number, number, number, number]): boolean {
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

async function fetchAll<T>(base: string, key: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let start = 0;
  for (;;) {
    const url = `${base}/${path}?limit=500&start=${String(start)}&api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`NPS responded ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { total: string; data: T[] };
    out.push(...data.data);
    start += 500;
    if (out.length >= Number(data.total) || data.data.length === 0) return out;
  }
}

export function createNpsAdapter(opts?: { endpoint?: string }): PoiSourceAdapter {
  const base = opts?.endpoint ?? "https://developer.nps.gov/api/v1";
  return {
    source: "nps",
    async fetchRegion(region: PoiRegion, { db }) {
      const keys = await getPoiSourceKeys(db);
      if (!keys.npsApiKey) return { unconfigured: "NPS API key not stored" };

      const [parks, campgrounds] = await Promise.all([
        fetchAll<NpsPark>(base, keys.npsApiKey, "parks"),
        fetchAll<NpsCampground>(base, keys.npsApiKey, "campgrounds"),
      ]);

      const records: PoiRecord[] = [];
      for (const p of parks) {
        const lat = Number(p.latitude);
        const lng = Number(p.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inBbox(lat, lng, region.bbox)) continue;
        records.push({
          source: "nps",
          sourceId: `park/${p.parkCode}`,
          name: p.fullName,
          category: "scenic",
          subcategory: p.designation ?? "park",
          lat,
          lng,
          // National parks are the popularity ceiling of public-lands data.
          popularity: p.designation === "National Park" ? 1 : 0.7,
          url: p.url,
        });
      }
      for (const c of campgrounds) {
        const lat = Number(c.latitude);
        const lng = Number(c.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inBbox(lat, lng, region.bbox)) continue;
        records.push({
          source: "nps",
          sourceId: `campground/${c.id}`,
          name: c.name,
          category: "campground",
          subcategory: c.parkCode ?? null,
          lat,
          lng,
          popularity: 0.6,
          url: c.url ?? null,
        });
      }
      return records;
    },
  };
}
