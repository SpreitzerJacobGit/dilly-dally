import type { PoiRecord, PoiRegion, PoiSourceAdapter } from "../types.js";
import { getPoiSourceKeys } from "../settings.js";

/** OpenChargeMap — EV/hookup charging locations by bounding box. */

interface OcmPoi {
  ID: number;
  AddressInfo?: {
    Title?: string;
    Latitude?: number;
    Longitude?: number;
    RelatedURL?: string;
  };
  NumberOfPoints?: number;
}

export function createOpenChargeMapAdapter(opts?: { endpoint?: string }): PoiSourceAdapter {
  const base = opts?.endpoint ?? "https://api.openchargemap.io/v3";
  return {
    source: "opencharge",
    async fetchRegion(region: PoiRegion, { db }) {
      const keys = await getPoiSourceKeys(db);
      if (!keys.openChargeMapApiKey) return { unconfigured: "OpenChargeMap API key not stored" };

      const [s, w, n, e] = region.bbox;
      const url =
        `${base}/poi?boundingbox=(${String(s)},${String(w)}),(${String(n)},${String(e)})` +
        `&maxresults=500&compact=true&verbose=false&key=${encodeURIComponent(keys.openChargeMapApiKey)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`OpenChargeMap responded ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as OcmPoi[];
      const records: PoiRecord[] = [];
      for (const p of data) {
        const lat = p.AddressInfo?.Latitude;
        const lng = p.AddressInfo?.Longitude;
        if (lat === undefined || lng === undefined) continue;
        records.push({
          source: "opencharge",
          sourceId: String(p.ID),
          name: p.AddressInfo?.Title ?? "Charging station",
          category: "ev-charge",
          subcategory: null,
          lat,
          lng,
          popularity: null,
          tags: { numberOfPoints: p.NumberOfPoints ?? null },
          url: `https://map.openchargemap.io/?id=${String(p.ID)}`,
        });
      }
      return records;
    },
  };
}
