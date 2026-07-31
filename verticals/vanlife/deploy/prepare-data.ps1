# Dilly-Dally one-time data preparation (authored — the generator never touches this).
#
# Fills the two EXTERNAL volumes the compose stack expects:
#   vanlife-osrm  — routing graph:  us-west-latest.osm.pbf -> osrm-extract/partition/customize (MLD)
#   vanlife-tiles — basemap.pmtiles + glyphs/ + sprites/
#
# The PWA manifest and icons are NOT here — they ship inside the image from the
# web app's public/ directory, so they survive volume resets and stay versioned
# with the build.
#
# Inputs (downloaded beforehand into -SourceDir):
#   us-west-latest.osm.pbf   https://download.geofabrik.de/north-america/us-west-latest.osm.pbf
#   basemap.pmtiles          pmtiles extract https://build.protomaps.com/<date>.pmtiles basemap.pmtiles --bbox=-125.5,31.0,-102.0,49.5
#   basemaps-assets/         git clone --depth 1 https://github.com/protomaps/basemaps-assets
#
# Re-run only when refreshing the map data. The verification loop's
# `docker compose down -v` never touches these volumes (they are external).
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [string]$OsrmImage = "osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409"
)
$ErrorActionPreference = "Stop"

docker volume create vanlife-osrm | Out-Null
docker volume create vanlife-tiles | Out-Null

Write-Host "== Routing graph (this takes a while and needs ~10+ GB of Docker memory) =="
docker run --rm -v vanlife-osrm:/data -v "${SourceDir}:/host:ro" $OsrmImage cp /host/us-west-latest.osm.pbf /data/
docker run --rm -v vanlife-osrm:/data $OsrmImage osrm-extract -p /opt/car.lua /data/us-west-latest.osm.pbf
docker run --rm -v vanlife-osrm:/data $OsrmImage osrm-partition /data/us-west-latest.osrm
docker run --rm -v vanlife-osrm:/data $OsrmImage osrm-customize /data/us-west-latest.osrm
# The .pbf is no longer needed inside the volume.
docker run --rm -v vanlife-osrm:/data $OsrmImage rm -f /data/us-west-latest.osm.pbf

Write-Host "== Basemap tiles + glyphs + sprites =="
docker run --rm -v vanlife-tiles:/tiles -v "${SourceDir}:/host:ro" alpine sh -c @'
cp /host/basemap.pmtiles /tiles/ &&
mkdir -p /tiles/glyphs /tiles/sprites &&
cp -r /host/basemaps-assets/fonts/. /tiles/glyphs/ &&
cp -r /host/basemaps-assets/sprites/. /tiles/sprites/
'@

Write-Host "Done. Volumes ready: vanlife-osrm, vanlife-tiles"
