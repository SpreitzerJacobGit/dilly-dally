# Dilly-Dally legal-camping overlay preparation (authored — the generator never touches this).
#
# Builds legal-camping.pmtiles onto the existing EXTERNAL vanlife-tiles volume,
# beside basemap.pmtiles. The tile plugin already serves any *.pmtiles in that
# directory and already lists it in /tiles/status, so nothing server-side changes.
#
# Two layers, deliberately kept separate — they are different legal regimes and
# merging them into one "legal" boolean would make the result unauditable:
#   blm_open_land        BLM surface-ownership polygons, unbuffered
#   usfs_legal_corridor  MVUM roads a van may drive, buffered by the legal
#                        camping distance and dissolved per forest, carrying
#                        confidence = verified_distance | default_buffer
#
# Inputs are downloaded automatically into -SourceDir if not already there:
#   Trans_MVUM_Road.gdb.zip  ~108 MB  https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_MVUM_Road.gdb.zip
#   BLM_SMA_National.zip     ~1.1 GB  https://www.arcgis.com/sharing/rest/content/items/6bf2e737c59d4111be92420ee5ab0b46/data
#
# Everything runs in a throwaway container, so no GIS toolchain is needed on the
# host — same approach as prepare-data.ps1. GDAL must be the *full* image: the
# alpine-small build has no GEOS, and without GEOS there is no ST_Buffer.
#
# Re-run seasonally or before a trip into new country. Source data changes about
# annually; there is no live sync and nothing polls.
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  # Matches the basemap archive's extent. Shading legality outside the basemap
  # and the routing graph would claim coverage the rest of the app does not have.
  [double]$West = -125.5,
  [double]$South = 31.0,
  [double]$East = -102.0,
  [double]$North = 49.5,
  [string]$GdalImage = "ghcr.io/osgeo/gdal:ubuntu-full-latest",
  [switch]$KeepIntermediates
)
$ErrorActionPreference = "Stop"

# Docker Desktop does not put its bin directory on PATH for non-interactive
# shells, and the credential helper lives there too — without it every pull
# fails with "error getting credentials" rather than anything about Docker.
$dockerBin = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (Test-Path (Join-Path $dockerBin "docker.exe")) { $env:PATH = "$dockerBin;$env:PATH" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "docker not found. Install Docker Desktop, or add its resources\bin to PATH."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$work = Join-Path $SourceDir "work"
$out = Join-Path $work "out"
New-Item -ItemType Directory -Force -Path $SourceDir, $work, $out | Out-Null
docker volume create vanlife-tiles | Out-Null

function Get-IfMissing([string]$Path, [string]$Url, [string]$Label) {
  if (Test-Path $Path) { Write-Host "  $Label already downloaded"; return }
  Write-Host "  downloading $Label ..."
  curl.exe -L --fail --retry 3 -o $Path $Url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }
}

Write-Host "== Source data =="
$mvumZip = Join-Path $SourceDir "Trans_MVUM_Road.gdb.zip"
$blmZip = Join-Path $SourceDir "BLM_SMA_National.zip"
Get-IfMissing $mvumZip "https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_MVUM_Road.gdb.zip" "USFS MVUM roads"
Get-IfMissing $blmZip "https://www.arcgis.com/sharing/rest/content/items/6bf2e737c59d4111be92420ee5ab0b46/data" "BLM SMA national"

# OpenFileGDB needs real random access, which /vsizip cannot provide for the
# SQL step, so the geodatabases are unpacked rather than read in place.
if (-not (Test-Path (Join-Path $work "Trans_MVUM_Road.gdb"))) {
  Write-Host "  extracting MVUM ..."; Expand-Archive -Path $mvumZip -DestinationPath $work -Force
}
if (-not (Test-Path (Join-Path $work "SMA_WM.gdb"))) {
  Write-Host "  extracting BLM ..."; Expand-Archive -Path $blmZip -DestinationPath $work -Force
}

# The buffer distances and the verified/estimated rule come from
# app/bespoke/src/server/engine/legalBuffer.ts, so there is exactly one
# definition of them and the unit tests cover it.
Write-Host "== Buffer rules and provenance =="
$retrieved = (Get-Item $mvumZip).LastWriteTime.ToString("yyyy-MM-dd")
Push-Location $repoRoot
try { pnpm tsx verticals/vanlife/deploy/build-forest-buffers.ts $out $retrieved }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "build-forest-buffers failed" }

$gdal = @("run", "--rm", "-v", "${work}:/w", $GdalImage)

Write-Host "== USFS: van-drivable segments, reprojected to metres =="
# EPSG:5070 (CONUS Albers) because ST_Buffer works in the layer's own units:
# buffering in degrees would stretch a 300 ft corridor by a third east-west.
# "open" is the dataset's own spelling; everything else is closed, blank or dirty.
docker @gdal ogr2ogr -f GPKG /w/out/usfs_open_5070.gpkg /w/Trans_MVUM_Road.gdb Trans_MVUM_Road `
  -nln roads -lco GEOMETRY_NAME=geometry -overwrite `
  -where "(PASSENGERVEHICLE = 'open' OR MOTORHOME = 'open') AND FORESTNAME IS NOT NULL" `
  -spat $West $South $East $North -spat_srs EPSG:4326 `
  -t_srs EPSG:5070 -nlt MULTILINESTRING
if ($LASTEXITCODE -ne 0) { throw "USFS filter/reproject failed" }

Write-Host "== USFS: buffer and dissolve per forest (slow - GEOS over ~110k segments) =="
docker @gdal ogr2ogr -f GPKG /w/out/usfs_corridor_5070.gpkg /w/out/usfs_open_5070.gpkg `
  -dialect SQLITE -sql "@/w/out/usfs-corridors.sql" `
  -nln usfs_legal_corridor -nlt MULTIPOLYGON -lco GEOMETRY_NAME=geometry -overwrite
if ($LASTEXITCODE -ne 0) { throw "USFS buffer/dissolve failed" }

Write-Host "== BLM: ownership polygons, clipped =="
# The national geodatabase ships an agency-split layer, so no attribute filter is
# needed beyond excluding the handful of rows coded to the department rather than
# the bureau — on a legality layer, only an explicit BLM code counts as BLM.
docker @gdal ogr2ogr -f GPKG /w/out/blm_4326.gpkg /w/SMA_WM.gdb SurfaceMgtAgy_BLM `
  -nln blm_open_land -lco GEOMETRY_NAME=geometry -overwrite `
  -where "ADMIN_AGENCY_CODE = 'BLM'" `
  -spat $West $South $East $North -spat_srs EPSG:4326 `
  -t_srs EPSG:4326 -nlt MULTIPOLYGON -select "ADMIN_ST,ADMIN_UNIT_NAME"
if ($LASTEXITCODE -ne 0) { throw "BLM clip failed" }

Write-Host "== Combine, clip and simplify =="
# -clipdst, not just -spat: -spat selects every feature that *intersects* the box
# but hands back its whole geometry, and these datasets are aggregated into
# multipolygons spanning several states. Without clipping, BLM land reaches ~7
# degrees past the basemap's eastern edge and would shade legality over a blank
# map — the exact overreach the bbox exists to prevent.
#
# ~20 m of simplification: well inside the slop of a buffer whose width is itself
# an assumption on most forests, and it removes most of the vertices. -makevalid
# repairs the self-intersections simplification can introduce.
Remove-Item (Join-Path $out "legal_combined.gpkg") -ErrorAction SilentlyContinue
docker @gdal ogr2ogr -f GPKG /w/out/legal_combined.gpkg /w/out/blm_4326.gpkg blm_open_land `
  -nln blm_open_land -lco GEOMETRY_NAME=geometry `
  -clipdst $West $South $East $North -simplify 0.0002 -makevalid -nlt MULTIPOLYGON
if ($LASTEXITCODE -ne 0) { throw "BLM combine failed" }
docker @gdal ogr2ogr -f GPKG -update -append /w/out/legal_combined.gpkg /w/out/usfs_corridor_5070.gpkg usfs_legal_corridor `
  -nln usfs_legal_corridor -t_srs EPSG:4326 `
  -clipdst $West $South $East $North -simplify 0.0002 -makevalid -nlt MULTIPOLYGON
if ($LASTEXITCODE -ne 0) { throw "USFS combine failed" }

Write-Host "== Tile to PMTiles (slowest step - roughly 2.5 hours) =="
# GDAL writes PMTiles directly, so there is no MBTiles step and no pmtiles binary
# on the host. z12 is the floor at which a 300 ft corridor is still a few pixels
# wide; MapLibre overzooms past it rather than blanking.
Remove-Item (Join-Path $out "legal-camping.pmtiles") -ErrorAction SilentlyContinue
docker @gdal ogr2ogr -f PMTiles /w/out/legal-camping.pmtiles /w/out/legal_combined.gpkg `
  -dsco MINZOOM=5 -dsco MAXZOOM=12 `
  -dsco "NAME=legal-camping" `
  -dsco "DESCRIPTION=Dispersed camping: BLM open land and USFS MVUM road corridors"
if ($LASTEXITCODE -ne 0) { throw "PMTiles write failed" }

Write-Host "== Install onto vanlife-tiles =="
docker run --rm -v vanlife-tiles:/tiles -v "${out}:/host:ro" alpine sh -c @'
cp /host/legal-camping.pmtiles /tiles/ &&
cp /host/legal-camping.json /tiles/
'@
if ($LASTEXITCODE -ne 0) { throw "install onto volume failed" }

if (-not $KeepIntermediates) {
  Remove-Item (Join-Path $out "usfs_open_5070.gpkg"), (Join-Path $out "usfs_corridor_5070.gpkg"),
              (Join-Path $out "blm_4326.gpkg"), (Join-Path $out "legal_combined.gpkg") -ErrorAction SilentlyContinue
}

$mb = [math]::Round((Get-Item (Join-Path $out "legal-camping.pmtiles")).Length / 1MB, 1)
Write-Host "Done. legal-camping.pmtiles ($mb MB) is on vanlife-tiles; /tiles/status will list it."
