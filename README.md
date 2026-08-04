# Dilly-Dally

A trip planner for two people living and working out of a van.

Give it an Origin and a final Target and it proposes three to five candidate routes each morning —
from "most direct" down to side-quest-tier detours — every one of them inside a deviation
budget of twice the straight-shot duration. It tracks the recurring needs of van life (food,
gas, water, laundry, trash, waste-water, electric hookup) as estimated percentages that drain with
time and miles, and weaves the stops that service them into the day's routes before anything
runs dry or overflows.

A trip is an **Origin** and an ordered list of **Targets**: the last one is where you end up,
and the ones before it are the regions and places the route has to pass through. One screen
holds the map, that list, today's candidates and the trip's numbers; Needs, Settings and
Status are their own pages. Several trips can be planned side by side — the one being
looked at and the one the van is actually on are deliberately different things.

It plans. It never navigates turn-by-turn — a chosen leg hands off to Google Maps.

Both operators are equals: either can check in a chore, pick a route, or reshape the plan.

## Why it's built this way

The van server is the source of truth and the internet is optional. That constraint drives
most of the design:

- **The basemap is served by the app itself** from a local PMTiles archive, with glyphs and
  sprites on the same volume. No tile request ever leaves the host.
- **Routing is a local OSRM sidecar** over a regional extract, not a hosted routing API.
- **Levels are honest estimates, never measurements.** A level is always labeled as an
  estimate, derived from the last check-in plus configured rate plus elapsed time and recorded
  miles. Nothing edits a level number directly — levels change only through check-ins.
- **The day ends where the night is spent.** A leg's endpoint is a real place chosen from
  four kinds — campground, dispersed site, hotel, overnight parking — ranked against the
  needs that are actually running down. What a stay costs is measured against carrying on
  toward tomorrow rather than as a there-and-back detour, because tomorrow starts from
  wherever you slept. Three things rule a place out rather than merely scoring it down: a
  road the van can't drive, more detour than the cap allows, and arriving after dark
  somewhere unlit. When nothing survives, the leg says so and names its endpoint as the
  reach of the day's drive — never as a place.
- **A level is a percentage, not a quantity.** Every tracked consumable runs 0 to 100
  whether it holds water, fuel or trash, because a percentage is what you can read off a
  gauge without converting. Drain rates are entered as the range a full tank lasts — 450
  miles of fuel, six days of waste-water capacity — and stored as percent per day or mile.
- **Degradation is visible, never silent.** Every POI source reports itself in exactly one
  honest state (unconfigured / never-checked / healthy / erroring, with the error and time).
  A failed push shows its error rather than the app claiming a digest was sent.

With no uplink, the dashboard, planning, map, check-ins, and digest all keep working. Only
external place refreshing and ntfy push delivery degrade, and both say so.

The behavioral contract this was built against is in
[`verticals/vanlife/intent.md`](verticals/vanlife/intent.md) — every requirement is written
as an observable statement about the running application.

## Layout

The app is assembled from reusable **elements** — versioned packages that each own one
capability (storage, session auth, interval jobs, map view, table views, …) — plus a
**bespoke** package holding the parts that are genuinely specific to van-life planning.

```
elements/                    19 reusable capability packages
  data/{intake,output,processing,storage}/
  system/{identity,lifecycle,observability,shell}/
verticals/vanlife/
  intent.md                  the behavioral contract
  requirements.md            expanded requirements
  assembly.manifest.yaml     which elements, which versions, which config
  data-model.yaml            source of truth for the schema
  db/migrations/             generated drizzle migrations
  app/bespoke/               van-life-specific domain: routing, needs, digest
  app/server/                fastify + tRPC host
  app/web/                   react + maplibre client
  deploy/                    Dockerfile, compose, data prep
```

`Dockerfile`, `compose.yaml`, `vite.config.ts` and `app/bespoke/src/db/schema.ts` are
generated from the manifest and data model — the header on each says so. Edit the manifest,
not the output.

## Running it

Requires Node 22+, pnpm 11+, and Docker for the full stack.

```sh
pnpm install
pnpm typecheck
pnpm test
```

### Local dev

```sh
DB_FILE=./verticals/vanlife/db/dev.db \
MIGRATIONS_DIR=./verticals/vanlife/db/migrations \
TILES_DIR=/tmp/tiles \
pnpm dev:server          # :18081, migrates and seeds on boot

pnpm dev:web             # vite, proxies /trpc to :18081
```

The map will be blank without a tile archive — that is reported honestly through the status
endpoint rather than rendering as a silently empty map.

### Full stack

The compose stack needs two prepared **external** volumes (map tiles and the OSRM graph),
because the database volume gets reset far more often than multi-gigabyte map data should.
One-time preparation, and the Tailscale setup used in the van, are documented in
[`verticals/vanlife/deploy/README.md`](verticals/vanlife/deploy/README.md).

```sh
docker compose -f verticals/vanlife/deploy/compose.yaml up -d --build
```

App on <http://localhost:18081>. Seeded operator accounts:

- `jacob@vanlife.test` / `van-demo-2026`
- `partner@vanlife.test` / `van-demo-2026`

These are demo credentials for a first run. Change them before exposing the app anywhere.

OSRM preprocessing for a US-West extract wants roughly 10+ GB of Docker memory; the running
sidecar uses `--mmap` so the graph stays on the page cache instead of resident memory.

## Data sources

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via
[Geofabrik](https://download.geofabrik.de/) extracts and [Protomaps](https://protomaps.com/)
basemap builds. Routing by [OSRM](https://project-osrm.org/). Place data comes from public
sources and is attributed per record with a link out — the app never rehosts another
service's content.

The optional legal-camping overlay is built from two public federal datasets — the USFS
[Motor Vehicle Use Map roads](https://data.fs.usda.gov/geodata/edw/datasets.php) and the BLM
[Surface Management Agency polygons](https://gbp-blm-egis.hub.arcgis.com/) — processed
offline into a local tile archive. It is **advisory**: the corridor width is a published
distance only for the handful of forests listed in
`verticals/vanlife/deploy/forest-camping-distance.json` and a conservative assumption
everywhere else, which the map draws as an estimate. Unshaded land means "unverified", not
"illegal".

## License

MIT — see [LICENSE](LICENSE).
