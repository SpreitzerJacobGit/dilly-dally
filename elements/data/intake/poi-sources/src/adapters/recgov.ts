import type { PoiRecord, PoiRegion, PoiSourceAdapter } from "../types.js";
import { getPoiSourceKeys } from "../settings.js";

/**
 * Recreation.gov's RIDB facilities API. Radius search only, so the region bbox
 * is covered by a circle around its center (radius capped at RIDB's 50 miles —
 * corridor cells should stay under ~100 km across).
 */

interface RidbFacility {
  FacilityID: string;
  FacilityName: string;
  FacilityTypeDescription?: string;
  FacilityLatitude?: number;
  FacilityLongitude?: number;
  Reservable?: boolean;
}

const TYPE_CATEGORY: Record<string, string> = {
  Campground: "campground",
  "Camping Lodging": "campground",
  Trailhead: "hike",
  "Day Use Area": "scenic",
};

export function createRecreationGovAdapter(opts?: { endpoint?: string }): PoiSourceAdapter {
  const base = opts?.endpoint ?? "https://ridb.recreation.gov/api/v1";
  return {
    source: "recgov",
    async fetchRegion(region: PoiRegion, { db }) {
      const keys = await getPoiSourceKeys(db);
      if (!keys.recreationGovApiKey) return { unconfigured: "Recreation.gov API key not stored" };

      const [s, w, n, e] = region.bbox;
      const lat = (s + n) / 2;
      const lng = (w + e) / 2;
      // Half the bbox diagonal in miles, capped at RIDB's maximum of 50.
      const spanMiles = Math.hypot((n - s) * 69, (e - w) * 69 * Math.cos((lat * Math.PI) / 180));
      const radius = Math.min(50, Math.max(10, Math.ceil(spanMiles / 2)));

      const records: PoiRecord[] = [];
      let offset = 0;
      for (;;) {
        const url =
          `${base}/facilities?latitude=${String(lat)}&longitude=${String(lng)}&radius=${String(radius)}` +
          `&limit=50&offset=${String(offset)}&full=false`;
        const res = await fetch(url, { headers: { apikey: keys.recreationGovApiKey } });
        if (!res.ok) {
          throw new Error(`RIDB responded ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
        }
        const data = (await res.json()) as { RECDATA: RidbFacility[]; METADATA?: { RESULTS?: { TOTAL_COUNT?: number } } };
        for (const f of data.RECDATA) {
          if (f.FacilityLatitude === undefined || f.FacilityLongitude === undefined) continue;
          const category = TYPE_CATEGORY[f.FacilityTypeDescription ?? ""];
          if (!category) continue;
          records.push({
            source: "recgov",
            sourceId: `facility/${f.FacilityID}`,
            name: f.FacilityName,
            category,
            subcategory: f.FacilityTypeDescription ?? null,
            lat: f.FacilityLatitude,
            lng: f.FacilityLongitude,
            // Reservable federal campgrounds are demonstrably in demand.
            popularity: f.Reservable ? 0.5 : 0.3,
            url: `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}`,
          });
        }
        offset += 50;
        const total = data.METADATA?.RESULTS?.TOTAL_COUNT ?? 0;
        if (offset >= Math.min(total, 400) || data.RECDATA.length === 0) break;
      }
      return records;
    },
  };
}
