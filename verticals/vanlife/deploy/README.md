# Dilly-Dally — deployment notes (authored)

`Dockerfile` and `compose.yaml` are generated from the assembly manifest — never edit them.
This file, `prepare-data.ps1`, `refresh-cell-signal.ps1`,
`install-cell-signal-schedule.ps1`, `build-cell-signal.ts`, `cell-signal-tiers.ts`, and the
repository-root `.dockerignore` are authored and survive regeneration.

The build context is the repository root (`compose.yaml` → `build.context: ../../..`), so
the root `.dockerignore` is load-bearing: without it every build ships the local scratch
directory of prepared map data (multiple GB) and `node_modules/` to the daemon. The
`Dockerfile` runs its own `pnpm install`, so nothing there is needed inside the image.

## One-time data preparation

The compose stack expects two **external** volumes holding prepared data. They are external
on purpose: the verification loop resets the app with `docker compose down -v` every pass,
which must wipe the database volume but never the multi-gigabyte map data.

1. Download inputs into a scratch directory:
   - `us-west-latest.osm.pbf` — https://download.geofabrik.de/north-america/us-west-latest.osm.pbf
   - `basemap.pmtiles` — `pmtiles extract https://build.protomaps.com/<yyyymmdd>.pmtiles basemap.pmtiles --bbox=-125.5,31.0,-102.0,49.5`
     (pmtiles CLI: https://github.com/protomaps/go-pmtiles/releases)
   - `basemaps-assets/` — `git clone --depth 1 https://github.com/protomaps/basemaps-assets`

   The PWA manifest and icons are not provisioned here — they live in
   `app/web/public/` and ship inside the image.
2. `powershell verticals/vanlife/deploy/prepare-data.ps1 -SourceDir <scratch dir>`
   - OSRM preprocessing (MLD) needs roughly 10+ GB of Docker memory for us-west.
   - Refreshing the map later = re-download + re-run; the app keeps running meanwhile.

## Cell signal overlay (optional)

A toggle-able map overlay colouring the map by expected cell coverage, from the FCC's
Broadband Data Collection mobile availability filings. Entirely optional: with no archive
installed the legend says so and withholds the switch, and nothing else changes.

Treat it as **modelled, not measured** — it is what the carriers filed, and it is well
known to be optimistic. The legend says so on screen for the same reason.

### One-time setup

1. Register for an FCC User Registration account and mint an API token at
   <https://broadbandmap.fcc.gov/login>.
2. Save it at the repository root as `.fcc-token` (gitignored):
   ```json
   { "username": "you@example.com", "token": "..." }
   ```
3. Build the first archive by hand — it takes a while, and you want to watch the first one:
   ```
   pwsh -File verticals/vanlife/deploy/refresh-cell-signal.ps1 -Force
   ```
4. Register the schedule so it keeps itself current:
   ```
   pwsh -File verticals/vanlife/deploy/install-cell-signal-schedule.ps1
   ```

### How it stays current

The FCC publishes mobile availability **by provider × state × technology — there is no
nationwide file**, so a hand-driven refresh of the 11 western states across three carriers
and two technologies is ~66 downloads. That is why this is scheduled rather than manual.

`refresh-cell-signal.ps1` checks the FCC's current availability date *before* doing any
work and exits in seconds if it already has it. The FCC refreshes roughly twice a year, so
nearly every weekly run is a no-op costing one API call. The archive is built into
`cell-signal.pmtiles`, installed onto the existing `vanlife-tiles` volume with an atomic
rename (the server is live and serving byte ranges out of that file), and the app picks it
up on the next map load.

Because the machine running the task is also the Docker host, nothing is published or
fetched — the output lands directly where it is served.

### When it goes wrong

Every run writes `cell-signal.json` beside the archive recording `asOfDate`, `lastRun`,
`lastSuccess` and `lastError`. The app's Status page reads it and shows a **Cell coverage
data** card. A scheduled task that has been failing since March shows up there as "Stale"
with the error, rather than only in Event Viewer — a stale overlay that still looks current
is worse than an absent one.

```
Start-ScheduledTask   -TaskName 'Dilly-Dally cell signal refresh'
Get-ScheduledTaskInfo -TaskName 'Dilly-Dally cell signal refresh'
```

### Before the first unattended run

Three things could not be confirmed while this was written and should be checked once
against real data — each is flagged in the code at the point it matters:

- **FCC API endpoint paths and auth header names** (`refresh-cell-signal.ps1`, top). The
  spec PDF is served behind an edge filter that refuses scripted fetches. The endpoints are
  confirmed to exist and to return 401 without credentials; the exact paths are not.
- **Column names** in the export (`build-cell-signal.ts` detects them by pattern and prints
  what it found, failing loudly with the header list if the H3 index column is missing).
- **Provider names per carrier** (`cell-signal-tiers.ts`). Matched on name rather than the
  numeric IDs, which move with corporate restructuring. Anything unmatched is reported with
  counts on the first run — put the leftovers in `cell-signal-providers.json` as
  `{"<name or id>": "att"}` and re-run.

## Run

```
docker compose -f verticals/vanlife/deploy/compose.yaml up -d --build
```

App: http://localhost:18081 (never host port 8080 — broken on the dev machine).
The OSRM sidecar publishes no host port; the app reaches it at `http://osrm:5000`.
Sign in with the seeded operator accounts (see `assembly.manifest.yaml` → `qa.credentials`).

## Remote access (the van setup)

Expose through Tailscale on the mini-PC:

```
tailscale serve --bg http://localhost:18081
```

The app speaks plain HTTP on 18081, so the target must be `http://`. `https+insecure://`
tells Tailscale the *backend* is HTTPS and yields a 502 against this app — the `insecure`
part only waives certificate checking, it does not downgrade the scheme. Tailscale still
terminates HTTPS on the public side either way.

That public HTTPS is **load-bearing**, not a nicety: browser geolocation and PWA install
both require a secure context, and plain `http://<ip>:18081` gets neither. Tailscale peer
traffic stays on-LAN in the van and MagicDNS resolves locally, so this keeps working with
no internet uplink.

Push notifications: Settings → configure the ntfy topic (treat the topic name as a
password), then subscribe to the same topic in the ntfy app on both phones.

## Offline expectations

With no internet uplink: dashboard, planning, map, check-ins, and the digest banner all
work — routing, tiles, and data are local. Only external place refreshing and ntfy push
delivery degrade, and both report their state honestly in the UI.
