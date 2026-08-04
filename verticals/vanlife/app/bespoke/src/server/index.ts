/**
 * Bespoke server layer for Dilly-Dally.
 * Declared features:
 *  - trips: Trips & waypoints (#trips)
 *  - needs: Recurring needs & levels (#needs)
 *  - checkins: Check-ins (#checkins)
 *  - poi: POI aggregation (#poi)
 *  - routes: Route candidates (#routes)
 *  - stays: Where we stay the night (#stays)
 *  - map-dashboard: Map dashboard (#map)
 *  - interests: Interest profile (#interests)
 *  - digest: Daily digest (#digest)
 *  - offline: Offline & remote (#offline)
 */
import type { SeedFn } from "@elements/lifecycle-migrate-seed";
import {
  digestRouter,
  interestsRouter,
  needsRouter,
  placesRouter,
  planRouter,
  poisRouter,
  sourcesRouter,
  staysRouter,
  tripsRouter,
} from "./routers.js";
import { seedVanlifeData } from "./seed.js";

export { createBespokeJobs } from "./jobs.js";

export const bespokeRouters = {
  trips: tripsRouter,
  plan: planRouter,
  needs: needsRouter,
  pois: poisRouter,
  places: placesRouter,
  interests: interestsRouter,
  digest: digestRouter,
  sources: sourcesRouter,
  stays: staysRouter,
};

export const bespokeSeeds: SeedFn[] = [seedVanlifeData];
