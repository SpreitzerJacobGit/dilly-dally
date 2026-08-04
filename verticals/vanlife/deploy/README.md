# Dilly-Dally — deployment notes (authored)

`Dockerfile` and `compose.yaml` are generated from the assembly manifest — never edit them.
This file, `prepare-data.ps1`, `refresh-cell-signal.ps1`,
`install-cell-signal-schedule.ps1`, `watch-cell-signal.ps1`, `build-cell-signal.ts`,
`cell-signal-tiers.ts`, `prepare-legal-overlay.ps1`, `build-forest-buffers.ts`,
`forest-camping-distance.json`, and the repository-root `.dockerignore` are authored and
survive regeneration.

## Volume names

`vanlife-tiles` and `vanlife-osrm` are declared `external:` and keep those literal names.
The data volume is **`vanlife_vanlife-data`** — Compose prefixes it with the project name
because it is *not* external. Every script that mounts it must use the prefixed name and
`docker volume inspect` before mounting, because `docker run -v <name>` **creates** a volume
that does not exist rather than failing: a typo here does not error, it silently reads an
empty directory forever.

Note also that `docker compose down -v` wipes this volume, and with it the saved FCC
credentials, the pending refresh request and the run status. That is coherent — the app's
settings live in the database on the same volume, so they go together — but it means the
credentials must be re-entered in Settings after a reset.

## A note on em dashes in these scripts

Keep them out of string literals. These files have no BOM, and Windows PowerShell 5.1 —
which is what `powershell.exe` is, and what the scheduled tasks run — reads them as ANSI,
where an em dash's UTF-8 bytes end in `0x94`: a curly quote that closes the string and
breaks the parse. In comments they are harmless. Check with:

```
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errs)
```

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
2. Enter it in the app under **Settings → Cell coverage → Set FCC credentials**, then press
   **Test credentials**. The app stores them and writes them to
   `/data/cell-signal/fcc-token.json` on the data volume, which is where the refresh reads
   them from.
3. Register the schedule and the host agent:
   ```
   pwsh -File verticals/vanlife/deploy/install-cell-signal-schedule.ps1
   ```
4. Build the first archive by hand — it takes a while, and you want to watch the first one:
   ```
   pwsh -File verticals/vanlife/deploy/refresh-cell-signal.ps1 -Force
   ```
   Or press **Refresh now** in Settings, which asks the host agent to do exactly this.

Credential precedence in `refresh-cell-signal.ps1` is: an explicitly-passed `-TokenFile`
wins (you named a file, you meant it), then the app's copy on the data volume, then the
repo-root `.fcc-token`. That last one still works and is what you want before the app is
even up:

```json
{ "username": "you@example.com", "token": "..." }
```

The token is never written to host disk by the refresh — it is base64'd out of the volume
straight into memory, because a temp file holding an API token has no reliable cleanup
(Task Scheduler kills a run at its time limit without running `finally`, and so does a
reboot).

### The host agent

The app cannot run the refresh. Its container has no Docker socket and no view of this
repo, and the pipeline is PowerShell driving GDAL and tippecanoe. So "Refresh now" writes a
request onto the data volume and `watch-cell-signal.ps1` — registered as a second scheduled
task, polling every 5 minutes — picks it up and runs `refresh-cell-signal.ps1`.

Four files in `/data/cell-signal` on `vanlife_vanlife-data`:

| File | Direction | What it carries |
| --- | --- | --- |
| `fcc-token.json` | app → host | `{username, token, savedAt}` |
| `request.json` | app → host | `{requestId, requestedAt, requestedBy, force}` |
| `status.json` | host → app | `{requestId, state, startedAt, heartbeatAt, finishedAt, exitCode, error, step}` |
| `watcher.json` | host → app | `{aliveAt, pollSeconds, busy, lastPollError}` |

`watcher.json` is rewritten on **every** poll, including idle ones. That is what lets the
app tell "the agent was never installed" apart from "the agent died on Tuesday" — different
causes, different fixes. An agent that only announced itself while working would be
indistinguishable from one that is absent.

Nobody deletes `request.json`; the app overwrites it with a fresh `requestId` and the host
claims it by echoing that id into `status.json`. Deleting the request is the classic race in
this pattern.

**Both tasks run only while this machine is signed in.** The principal is Interactive
because Docker Desktop generally is not running when nobody is logged on, so an S4U task
would fail every time. For a van server, enable auto sign-in and leave it at a locked
screen — a locked session is still signed in.

The agent cannot report a Docker outage, because the channel *is* Docker. The app therefore
says "no host agent has responded" and never "the watcher is not installed". A result
produced while Docker was down is held in `.data-src/cell-signal/pending-status.json` and
flushed on a later poll rather than lost.

```
Start-ScheduledTask   -TaskName 'Dilly-Dally cell signal watcher'
Get-ScheduledTaskInfo -TaskName 'Dilly-Dally cell signal watcher'
pwsh -File verticals/vanlife/deploy/watch-cell-signal.ps1 -Once -Verbose
```

That last line is the real path, not a debug one: `-Once` is exactly what the task runs.
Per-run logs are under `.data-src/cell-signal/runs/`.

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

There are now two status sources, and they answer different questions.
`cell-signal.json` on the **tiles** volume answers *how old is the data* — it is what the
Status page card reads. `status.json` on the **data** volume answers *what happened to the
button I just pressed*, and is what Settings reads. They can legitimately disagree: an
interrupted run never reaches the point of updating the tiles manifest, and a successful run
that found nothing new leaves `asOfDate` exactly where it was.

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

The host agent adds four more, none of which can be exercised from the test suite:

- **`Start-Process -PassThru` exit codes.** The handle is cached immediately
  (`$null = $proc.Handle`) because otherwise `ExitCode` can come back null.
- **Whether `$trigger.Repetition` survives `Register-ScheduledTask`** under a Limited
  principal — check with `Get-ScheduledTask` after the first install that the watcher really
  repeats.
- **Whether `docker.exe` is on PATH** for a `-NonInteractive` scheduled task even with the
  prepend both scripts now do.
- **Whether `-ExecutionTimeLimit` kills the process tree or only the watcher.** Only the
  watcher would orphan a running refresh, which is why the agent detects an orphan on start
  and reports `interrupted` rather than starting a second build.
## Legal camping overlay (optional)

A second PMTiles archive on the same `vanlife-tiles` volume, shading where dispersed
camping is permitted. Entirely optional: without it the map behaves normally, the legend
offers no switches for it, and the Status page reports "Not installed".

```
powershell verticals/vanlife/deploy/prepare-legal-overlay.ps1 -SourceDir <scratch dir>
```

It downloads its own inputs (~1.2 GB total, cached in `-SourceDir`):

- `Trans_MVUM_Road.gdb.zip` — https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_MVUM_Road.gdb.zip
  (note `data.fs.usda.gov`, not `www.` — the `www` path 404s)
- `BLM_SMA_National.zip` — https://www.arcgis.com/sharing/rest/content/items/6bf2e737c59d4111be92420ee5ab0b46/data

Notes:

- **Docker Desktop is not on PATH for non-interactive shells**, and its credential helper
  lives in the same directory. The script prepends `%ProgramFiles%\Docker\Docker\resources\bin`
  itself; if you run these steps by hand, do the same or every pull fails with
  "error getting credentials" rather than anything mentioning Docker.
- GDAL must be the **full** image (`ubuntu-full-latest`). `alpine-small` has no GEOS, so
  `ST_Buffer` silently yields nulls. GDAL 3.14 writes PMTiles directly, so there is no
  tippecanoe step and no pmtiles binary needed on the host.
- **This takes about three hours.** Measured on a first full run: ~2 min filter/reproject,
  ~13 min buffer + dissolve (GEOS over ~110k road segments), ~8 min clip/simplify/makevalid,
  and ~2.5 hours for the tiling pass, which is by far the slowest step. Start it and leave it.
  GDAL warns that a few dense tiles exceeded 500 kB and were encoded at lower resolution;
  that is the tiler degrading gracefully, not an error.
- The finished archive is ~150 MB (z5–12, ~55k tiles) — small beside the 5 GB basemap on
  the same volume.
- Output is clipped to the same bbox as the basemap (`-125.5,31.0,-102.0,49.5`). Shading
  legality where there is no basemap and no routing graph would claim coverage the rest of
  the app does not have. Override with `-West/-South/-East/-North`.
- Refresh seasonally or before a trip into new country — the source data changes about
  annually and nothing polls it.

**The camping distance is not in the source data.** The national MVUM roads dataset has no
camping-distance attribute, so `forest-camping-distance.json` holds the distances that were
actually looked up, each with the URL it came from. Forests absent from it are buffered at
the 300 ft default and marked `default_buffer`, which the map draws with a dashed edge. To
add a forest: find its official dispersed-camping or MVUM page, quote the distance, and add
an entry keyed by its exact `FORESTNAME`. An entry with no `source` is rejected at build time.

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
