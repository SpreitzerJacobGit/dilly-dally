# Dilly-Dally — deployment notes (authored)

`Dockerfile` and `compose.yaml` are generated from the assembly manifest — never edit them.
This file, `prepare-data.ps1`, and the repository-root `.dockerignore` are authored and
survive regeneration.

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
