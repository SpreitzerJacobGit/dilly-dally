import type { Db } from "@elements/storage-sqlite-drizzle";
import { PoiRecordSchema, type OnPois, type PoiRecord } from "./types.js";

/**
 * One-shot dataset import (iOverlander dumps, hand-curated lists). Validates
 * every record, feeds the same bespoke hook as the pollers in batches, and
 * reports what it rejected instead of silently dropping rows.
 */
export async function importPoiDataset(opts: {
  db: Db;
  onPois: OnPois;
  records: unknown[];
  /** Region label recorded in the meta passed to onPois. */
  label?: string;
}): Promise<{ imported: number; rejected: { index: number; reason: string }[] }> {
  const valid: PoiRecord[] = [];
  const rejected: { index: number; reason: string }[] = [];
  opts.records.forEach((raw, index) => {
    const parsed = PoiRecordSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else rejected.push({ index, reason: parsed.error.issues[0]?.message ?? "invalid" });
  });

  const region = { key: opts.label ?? "dataset-import", bbox: [-90, -180, 90, 180] as [number, number, number, number] };
  let imported = 0;
  for (let i = 0; i < valid.length; i += 500) {
    const batch = valid.slice(i, i + 500);
    const source = batch[0]?.source ?? "dataset";
    await opts.onPois(opts.db, batch, { source, region });
    imported += batch.length;
  }
  return { imported, rejected };
}

/** Map a GeoJSON FeatureCollection into PoiRecords via a per-feature mapper. */
export function geojsonToPoiRecords(
  featureCollection: {
    features: { geometry?: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }[];
  },
  map: (props: Record<string, unknown>, lngLat: [number, number]) => Omit<PoiRecord, "lat" | "lng"> | null,
): PoiRecord[] {
  const out: PoiRecord[] = [];
  for (const f of featureCollection.features) {
    if (f.geometry?.type !== "Point") continue;
    const coords = f.geometry.coordinates as [number, number];
    const mapped = map(f.properties ?? {}, coords);
    if (mapped) out.push({ ...mapped, lat: coords[1], lng: coords[0] });
  }
  return out;
}
