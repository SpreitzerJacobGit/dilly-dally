/**
 * Deterministic seed fixtures — the demo trip is Jacob's real first leg:
 * Portland, OR → Las Vegas, NV routed through California via a Bishop, CA
 * waypoint (the US-395 corridor). The generator folds seedIntentSection()
 * into the intent document, which is what makes semantic drift
 * contradictable. Check-ins are daysAgo-relative so statuses are stable on
 * whatever day the database is seeded.
 */
import { deriveRunway, runwayUrgency, type CheckInEvent } from "../server/engine/needs.js";

export interface FixtureCheckIn {
  kind: "service" | "set-level";
  quantity: number | null;
  daysAgo: number;
  note?: string;
}

export interface FixtureNeed {
  key: string;
  title: string;
  unit: string;
  capacity: number;
  direction: "depletes" | "accumulates";
  warnRatio: number;
  urgentRatio: number;
  poiCategory: string | null;
  routingDriver: boolean;
  sortOrder: number;
  ratePerDay: number;
  ratePerMile: number;
  checkIns: FixtureCheckIn[];
}

export const FIXTURE_NEEDS: FixtureNeed[] = [
  {
    key: "food", title: "Food & groceries", unit: "days", capacity: 7, direction: "depletes",
    warnRatio: 0.25, urgentRatio: 0.1, poiCategory: "grocery", routingDriver: true, sortOrder: 1,
    ratePerDay: 1, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 3, note: "Full grocery run before departure" }],
  },
  {
    key: "gas", title: "Fuel", unit: "gal", capacity: 30, direction: "depletes",
    warnRatio: 0.3, urgentRatio: 0.15, poiCategory: "fuel", routingDriver: true, sortOrder: 2,
    ratePerDay: 0, ratePerMile: 0.067,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 2, note: "Topped off in Portland" }],
  },
  {
    key: "water", title: "Fresh water", unit: "gal", capacity: 40, direction: "depletes",
    warnRatio: 0.25, urgentRatio: 0.1, poiCategory: "water-fill", routingDriver: true, sortOrder: 3,
    ratePerDay: 6, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 2, note: "Filled tank at home" }],
  },
  {
    key: "electric", title: "Battery", unit: "%", capacity: 100, direction: "depletes",
    warnRatio: 0.3, urgentRatio: 0.15, poiCategory: "ev-charge", routingDriver: true, sortOrder: 4,
    ratePerDay: 25, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 1, note: "Shore power overnight" }],
  },
  {
    key: "laundry", title: "Laundry", unit: "loads", capacity: 3, direction: "accumulates",
    warnRatio: 0.34, urgentRatio: 0.1, poiCategory: "laundry", routingDriver: true, sortOrder: 5,
    ratePerDay: 0.25, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 8, note: "Laundromat before the trip" }],
  },
  {
    key: "trash", title: "Trash", unit: "bags", capacity: 4, direction: "accumulates",
    warnRatio: 0.25, urgentRatio: 0.1, poiCategory: "dump-station", routingDriver: true, sortOrder: 6,
    ratePerDay: 0.5, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 3 }],
  },
  {
    key: "wastewater", title: "Waste water", unit: "gal", capacity: 30, direction: "accumulates",
    warnRatio: 0.25, urgentRatio: 0.1, poiCategory: "dump-station", routingDriver: true, sortOrder: 7,
    ratePerDay: 5, ratePerMile: 0,
    checkIns: [{ kind: "service", quantity: null, daysAgo: 4.5, note: "Dumped tanks" }],
  },
  {
    key: "internet", title: "Work internet", unit: "days", capacity: 1, direction: "depletes",
    warnRatio: 0.25, urgentRatio: 0.1, poiCategory: null, routingDriver: false, sortOrder: 8,
    ratePerDay: 0, ratePerMile: 0,
    checkIns: [],
  },
];

export interface FixturePoi {
  source: "manual";
  sourceId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  popularity: number | null;
}

export const FIXTURE_POIS: FixturePoi[] = [
  { source: "manual", sourceId: "champoeg", name: "Champoeg State Park Campground", category: "campground", lat: 45.2501, lng: -122.8875, popularity: 0.5 },
  { source: "manual", sourceId: "pilot-salem", name: "Pilot Travel Center Salem", category: "fuel", lat: 44.9072, lng: -123.0016, popularity: null },
  { source: "manual", sourceId: "silver-falls", name: "Silver Falls State Park", category: "hike", lat: 44.8781, lng: -122.6547, popularity: 0.85 },
  { source: "manual", sourceId: "salem-dump", name: "Salem RV Dump Station", category: "dump-station", lat: 44.9219, lng: -123.0113, popularity: null },
  { source: "manual", sourceId: "corvallis-laundry", name: "Corvallis Suds Laundromat", category: "laundry", lat: 44.5646, lng: -123.262, popularity: null },
  { source: "manual", sourceId: "row-river-trail", name: "Row River Bike Trail", category: "bike", lat: 43.7519, lng: -122.9273, popularity: 0.6 },
  { source: "manual", sourceId: "eugene-dump", name: "Eugene RV Dump & Water", category: "dump-station", lat: 44.0736, lng: -123.0575, popularity: null },
  { source: "manual", sourceId: "eugene-laundry", name: "Eugene Laundromat", category: "laundry", lat: 44.0521, lng: -123.0868, popularity: null },
  { source: "manual", sourceId: "sahalie-falls", name: "Sahalie Falls", category: "scenic", lat: 44.3499, lng: -121.9997, popularity: 0.75 },
  { source: "manual", sourceId: "umpqua-hot-springs", name: "Umpqua Hot Springs", category: "scenic", lat: 43.2942, lng: -122.3665, popularity: 0.8 },
  { source: "manual", sourceId: "susan-creek", name: "Susan Creek Campground", category: "campground", lat: 43.2967, lng: -122.9034, popularity: 0.55 },
  { source: "manual", sourceId: "safeway-eugene", name: "Safeway Eugene", category: "grocery", lat: 44.0455, lng: -123.0905, popularity: null },
  { source: "manual", sourceId: "crater-lake", name: "Crater Lake Rim Village", category: "scenic", lat: 42.9109, lng: -122.1448, popularity: 0.95 },
  { source: "manual", sourceId: "diamond-lake", name: "Diamond Lake Campground", category: "campground", lat: 43.1609, lng: -122.1341, popularity: 0.5 },
  { source: "manual", sourceId: "kfalls-dump", name: "Klamath Falls RV Dump Station", category: "dump-station", lat: 42.2249, lng: -121.7817, popularity: null },
  { source: "manual", sourceId: "collier-water", name: "Collier Rest Area Water Fill", category: "water-fill", lat: 42.6512, lng: -121.9761, popularity: null },
  { source: "manual", sourceId: "susanville-laundry", name: "Susanville Laundromat", category: "laundry", lat: 40.4163, lng: -120.653, popularity: null },
  { source: "manual", sourceId: "maverik-reno", name: "Maverik Reno", category: "fuel", lat: 39.5296, lng: -119.8138, popularity: null },
  { source: "manual", sourceId: "winco-carson", name: "WinCo Foods Carson City", category: "grocery", lat: 39.1638, lng: -119.7674, popularity: null },
  { source: "manual", sourceId: "mono-lake", name: "Mono Lake South Tufa", category: "scenic", lat: 37.9389, lng: -119.0269, popularity: 0.85 },
  { source: "manual", sourceId: "june-lake", name: "June Lake Campground", category: "campground", lat: 37.7841, lng: -119.0727, popularity: 0.6 },
  { source: "manual", sourceId: "bishop-water", name: "Bishop City Park Water Fill", category: "water-fill", lat: 37.3688, lng: -118.4001, popularity: null },
  { source: "manual", sourceId: "bishop-chevron", name: "Chevron Bishop", category: "fuel", lat: 37.3614, lng: -118.3997, popularity: null },
  { source: "manual", sourceId: "buttermilks", name: "Buttermilks Boulders", category: "boulder", lat: 37.3283, lng: -118.5771, popularity: 0.9 },
  { source: "manual", sourceId: "happies", name: "Happy Boulders", category: "boulder", lat: 37.4171, lng: -118.4382, popularity: 0.7 },
  { source: "manual", sourceId: "alabama-hills", name: "Alabama Hills Movie Road", category: "hike", lat: 36.6096, lng: -118.1015, popularity: 0.8 },
  { source: "manual", sourceId: "lone-pine-dump", name: "Lone Pine RV Dump", category: "dump-station", lat: 36.6002, lng: -118.0617, popularity: null },
  { source: "manual", sourceId: "zabriskie", name: "Zabriskie Point, Death Valley", category: "scenic", lat: 36.4201, lng: -116.8108, popularity: 0.9 },
  { source: "manual", sourceId: "pahrump-rv", name: "Pahrump RV Resort", category: "campground", lat: 36.2083, lng: -115.9839, popularity: 0.4 },
];

export const FIXTURE_TRIP = {
  name: "Portland → Las Vegas",
  originName: "Portland, OR",
  originLat: 45.5152,
  originLng: -122.6784,
  destName: "Las Vegas, NV",
  destLat: 36.1699,
  destLng: -115.1398,
  dailyDriveHours: 4,
  deviationBudgetRatio: 2,
  startedDaysAgo: 2,
};

/**
 * A broad area anchor rather than a bare pin: the route must pass through the
 * eastern Sierra somewhere, and the engine picks the concrete spot. Centered
 * and sized so the whole US-395 corridor — Mono Lake, June Lake, Bishop, the
 * Buttermilks, Alabama Hills — is inside, while Reno (159 mi), Carson City
 * (136 mi) and Susanville (234 mi) are demonstrably outside. Narrowing it to
 * Bishop or the Buttermilks is what the operator does in the demo.
 */
export const FIXTURE_ANCHOR = {
  name: "Eastern Sierra / US-395 corridor",
  lat: 37.45,
  lng: -118.55,
  radiusMiles: 110,
  kind: "custom" as const,
  notes: "Route me through here somewhere — anywhere along 395 qualifies.",
};

export const FIXTURE_WEIGHTS: { category: string; weight: number }[] = [
  { category: "hike", weight: 1.5 },
  { category: "boulder", weight: 1.3 },
  { category: "campground", weight: 1.2 },
  { category: "bike", weight: 1 },
  { category: "scenic", weight: 1 },
  { category: "family", weight: 1 },
];

export function fixtureNeedStatus(need: FixtureNeed): { runway: number; urgency: string } {
  const now = Date.now();
  const events: CheckInEvent[] = need.checkIns.map((c) => ({
    kind: c.kind,
    quantity: c.quantity,
    occurredAt: new Date(now - c.daysAgo * 86_400_000).toISOString(),
  }));
  const { runway } = deriveRunway(
    need,
    events,
    { ratePerDay: need.ratePerDay, ratePerMile: need.ratePerMile },
    new Date(now).toISOString(),
    () => 0,
  );
  return { runway: Math.round(runway * 10) / 10, urgency: runwayUrgency(need, runway) };
}

/** The seed-data section of the intent document — computed, never hand-typed. */
export function seedIntentSection(): string {
  const lines: string[] = ["## Seed data on first run", ""];
  let n = 1;
  const claim = (text: string): void => {
    lines.push(`\`[SEED-${String(n)}]\` ${text}`);
    n++;
  };

  claim(
    `One active trip exists: "${FIXTURE_TRIP.name}", with Origin ${FIXTURE_TRIP.originName} and final Target ${FIXTURE_TRIP.destName}, plus one pending ${String(FIXTURE_ANCHOR.radiusMiles)}-mile area Target, "${FIXTURE_ANCHOR.name}", that every generated route must pass through; it resolves automatically to the best-scoring place inside it and can be narrowed to a specific one.`,
  );
  claim(`The statuses screen lists exactly ${String(FIXTURE_NEEDS.length)} needs, all tracked by level.`);

  for (const need of FIXTURE_NEEDS) {
    const { urgency } = fixtureNeedStatus(need);
    const drivers =
      need.ratePerMile > 0
        ? `${String(need.ratePerMile)} ${need.unit}/mile`
        : `${String(need.ratePerDay)} ${need.unit}/day`;
    claim(
      `${need.title}: capacity ${String(need.capacity)} ${need.unit}, consumes about ${drivers}, currently ${urgency === "ok" ? "not flagged" : `flagged "${urgency}"`}${need.routingDriver ? "" : " — tracked as a checklist item, never generating route stops"}.`,
    );
  }

  claim(`Exactly ${String(FIXTURE_POIS.length)} seeded places exist along the corridor, all attributed to the "manual" source.`);
  const scenic = FIXTURE_POIS.filter((p) => p.category === "scenic").length;
  const boulders = FIXTURE_POIS.filter((p) => p.category === "boulder").length;
  claim(
    `Among them: ${String(scenic)} scenic places (including Crater Lake Rim Village) and ${String(boulders)} bouldering areas (including Buttermilks Boulders).`,
  );
  claim(
    `Interest weights arrive seeded for ${FIXTURE_WEIGHTS.map((w) => w.category).join(", ")} — hike highest at ${String(FIXTURE_WEIGHTS[0]!.weight)}.`,
  );
  claim(
    "No digest exists until the first morning generation or an explicit send — the digest banner honestly shows nothing rather than a made-up summary.",
  );

  return lines.join("\n") + "\n";
}
