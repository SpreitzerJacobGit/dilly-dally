import { z } from "zod";
import type { Db } from "@elements/storage-sqlite-drizzle";
import { getSetting, setSetting } from "@elements/lifecycle-app-settings";

/** Operator-entered API keys — stored lifecycle configuration, never env. */
export const PoiSourceKeysSchema = z.object({
  npsApiKey: z.string().optional(),
  recreationGovApiKey: z.string().optional(),
  openChargeMapApiKey: z.string().optional(),
});
export type PoiSourceKeys = z.infer<typeof PoiSourceKeysSchema>;
export const POI_SOURCES_SETTINGS_KEY = "poi-sources";

export async function getPoiSourceKeys(db: Db): Promise<PoiSourceKeys> {
  const stored = await getSetting(db, POI_SOURCES_SETTINGS_KEY, PoiSourceKeysSchema);
  return stored?.value ?? {};
}

export async function savePoiSourceKeys(
  db: Db,
  value: PoiSourceKeys,
  updatedBy: string | null,
): Promise<void> {
  await setSetting(db, POI_SOURCES_SETTINGS_KEY, PoiSourceKeysSchema, value, updatedBy);
}

/** Which stored key each keyed source needs; overpass is keyless. */
export const SOURCE_KEY_FIELDS: Record<string, keyof PoiSourceKeys> = {
  nps: "npsApiKey",
  recgov: "recreationGovApiKey",
  opencharge: "openChargeMapApiKey",
};
