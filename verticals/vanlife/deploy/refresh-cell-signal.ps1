# Dilly-Dally cell signal overlay refresh (authored — the generator never touches this).
#
# Builds cell-signal.pmtiles from the FCC's mobile broadband availability
# filings and installs it on the EXTERNAL vanlife-tiles volume, beside the
# basemap. Nothing else has to happen: the app serves that volume as static
# files, so a new archive is live on the next map load.
#
# Meant to be run unattended by a scheduled task — see
# install-cell-signal-schedule.ps1. It checks before it works: the FCC refreshes
# roughly twice a year, so almost every run should exit in seconds having
# downloaded nothing.
#
# One-time setup:
#   1. Register for an FCC User Registration account and mint an API token at
#      https://broadbandmap.fcc.gov/login
#   2. Save it next to the repo root as .fcc-token (gitignored):
#        { "username": "you@example.com", "token": "..." }
#
# Everything it writes goes to two places: the archive on the volume, and
# cell-signal.json beside it recording what was installed and when the refresh
# last managed to run. That manifest is what the app's status page reads, so a
# task that has been failing since March is visible in the app rather than only
# in Event Viewer.
param(
  [string]$WorkDir = (Join-Path $PSScriptRoot "../../../.data-src/cell-signal"),
  [string]$TokenFile = (Join-Path $PSScriptRoot "../../../.fcc-token"),
  [string]$ProvidersFile = (Join-Path $PSScriptRoot "cell-signal-providers.json"),
  [string]$Volume = "vanlife-tiles",
  # The US West bbox the basemap is extracted to. Keep in step with
  # prepare-data.ps1's --bbox, or the overlay will claim coverage off the edge
  # of the map, or stop short of it.
  [string[]]$States = @("WA", "OR", "CA", "ID", "NV", "UT", "AZ", "MT", "WY", "CO", "NM"),
  [int]$ParentRes = 7,
  # Pin these by digest the way prepare-data.ps1 pins the OSRM image, once you
  # have confirmed which versions work here.
  [string]$GdalImage = "ghcr.io/osgeo/gdal:alpine-small-latest",
  [string]$TippecanoeImage = "ghcr.io/felt/tippecanoe:latest",
  [switch]$Force
)
$ErrorActionPreference = "Stop"

# ── FCC Broadband Data Collection API ────────────────────────────────────────
# UNVERIFIED — confirm before the first unattended run.
#
# The public spec (fcc.gov/sites/default/files/bdc-public-data-api-spec.pdf) is
# served behind an edge filter that refuses scripted fetches, so these paths
# and header names were not confirmed against the live API. What IS confirmed:
# the endpoints exist under this base and return 401 without credentials, and
# the FCC documents programmatic download as the supported alternative to
# clicking through ~66 files by hand.
#
# Everything downstream of Get-FccFiles is independent of these names — if they
# are wrong, only this section changes.
$FccBase = "https://broadbandmap.fcc.gov/api/public/map"
$FccListDatesUrl = "$FccBase/listAsOfDates"
$FccListFilesUrl = "$FccBase/downloads/listAvailabilityData"
$FccDownloadUrl = "$FccBase/downloads/downloadFile/availability"

$ArchiveName = "cell-signal.pmtiles"
$ManifestName = "cell-signal.json"

function Get-FccAuthHeaders {
  if (-not (Test-Path $TokenFile)) {
    throw "No FCC credentials at $TokenFile. See the header of this script for the one-time setup."
  }
  $creds = Get-Content $TokenFile -Raw | ConvertFrom-Json
  if (-not $creds.username -or -not $creds.token) {
    throw "$TokenFile must contain both 'username' and 'token'."
  }
  # UNVERIFIED header names — the BDC API authenticates with the registered
  # username plus the token, not a bearer header.
  return @{ "username" = $creds.username; "hash_value" = $creds.token }
}

# Reads the manifest already on the volume, or $null. This is how the script
# knows whether it has anything to do.
function Get-InstalledManifest {
  $json = docker run --rm -v "${Volume}:/tiles" alpine sh -c "cat /tiles/$ManifestName 2>/dev/null"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) { return $null }
  try { return $json | ConvertFrom-Json } catch { return $null }
}

# Written on every run, success or failure. A refresh that is failing must say
# so somewhere the app can see, which is the whole point of the sidecar.
function Set-Manifest([string]$AsOfDate, [string]$LastSuccess, [string]$LastError) {
  $manifest = [ordered]@{
    asOfDate    = $AsOfDate
    lastRun     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    lastSuccess = $LastSuccess
    lastError   = $LastError
  } | ConvertTo-Json -Compress
  # base64 through the shell so quoting survives the trip into the container.
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($manifest))
  docker run --rm -v "${Volume}:/tiles" alpine sh -c "echo $b64 | base64 -d > /tiles/$ManifestName" | Out-Null
}

function Get-FccCurrentAsOfDate([hashtable]$Headers) {
  $dates = Invoke-RestMethod -Uri $FccListDatesUrl -Headers $Headers -Method Get
  # Newest first is not guaranteed; sort rather than trust the order.
  $available = @($dates.data | ForEach-Object { $_.as_of_date }) | Sort-Object -Descending
  if ($available.Count -eq 0) { throw "FCC returned no availability dates." }
  return $available[0]
}

function Get-FccFiles([hashtable]$Headers, [string]$AsOfDate) {
  $all = @()
  foreach ($state in $States) {
    $url = "$FccListFilesUrl/$AsOfDate" + "?category=Mobile&subcategory=Mobile%20Broadband&stateFips=$state"
    $listing = Invoke-RestMethod -Uri $url -Headers $Headers -Method Get
    $all += $listing.data
    # The documented limit is ~10 calls/minute. Unattended and twice a year, so
    # there is nothing to gain by crowding it.
    Start-Sleep -Seconds 7
  }
  return $all
}

$installed = Get-InstalledManifest
$previousSuccess = if ($installed) { $installed.lastSuccess } else { $null }

try {
  $headers = Get-FccAuthHeaders
  $asOf = Get-FccCurrentAsOfDate -Headers $headers
  Write-Host "FCC current availability date: $asOf"

  if (-not $Force -and $installed -and $installed.asOfDate -eq $asOf) {
    Write-Host "Already installed and current. Nothing to do."
    Set-Manifest -AsOfDate $asOf -LastSuccess $previousSuccess -LastError $null
    exit 0
  }

  $raw = Join-Path $WorkDir "raw"
  $csv = Join-Path $WorkDir "csv"
  foreach ($dir in @($raw, $csv)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  Write-Host "== Downloading FCC mobile availability ($($States.Count) states) =="
  $files = Get-FccFiles -Headers $headers -AsOfDate $asOf
  if ($files.Count -eq 0) { throw "FCC listed no mobile broadband files for $asOf." }
  foreach ($file in $files) {
    $target = Join-Path $raw "$($file.file_id).zip"
    Invoke-WebRequest -Uri "$FccDownloadUrl/$($file.file_id)/1" -Headers $headers -OutFile $target
    Start-Sleep -Seconds 7
  }
  Write-Host "Downloaded $($files.Count) files."

  # Attributes only. Geometry is regenerated from the H3 index in the build
  # step, which is far cheaper than reprojecting millions of source polygons.
  Write-Host "== Flattening to attributes =="
  docker run --rm -v "${WorkDir}:/work" $GdalImage sh -c @'
set -e
mkdir -p /work/csv
for z in /work/raw/*.zip; do
  base=$(basename "$z" .zip)
  mkdir -p "/work/unz/$base" && unzip -oq "$z" -d "/work/unz/$base"
  src=$(find "/work/unz/$base" \( -name '*.gpkg' -o -name '*.shp' \) | head -1)
  [ -z "$src" ] && continue
  ogr2ogr -f CSV "/work/csv/$base.csv" "$src"
done
'@
  if ($LASTEXITCODE -ne 0) { throw "ogr2ogr failed." }

  Write-Host "== Aggregating hexes =="
  $providersArg = if (Test-Path $ProvidersFile) { @("--providers", $ProvidersFile) } else { @() }
  $geojson = Join-Path $WorkDir "coverage.geojsonl"
  # --cells-out writes the same hexes a second time as a lookup table for the
  # server. Without it the coverage overlay is write-only to the map, and the
  # stay scorer cannot tell whether the spot it picked has any signal to work
  # from in the morning.
  $cellsOut = Join-Path $WorkDir "cell-signal-cells.json"
  & pnpm exec tsx (Join-Path $PSScriptRoot "build-cell-signal.ts") `
    --in $csv --out $geojson --parent-res $ParentRes --cells-out $cellsOut --as-of $asOf @providersArg
  if ($LASTEXITCODE -ne 0) { throw "build-cell-signal.ts failed." }

  Write-Host "== Tiling =="
  # Layer name must stay "coverage" — MapView references it as source-layer,
  # and a mismatch loads the source fine while drawing nothing at all.
  docker run --rm -v "${WorkDir}:/work" $TippecanoeImage `
    tippecanoe -o /work/$ArchiveName -l coverage `
    --minimum-zoom=3 --maximum-zoom=9 --drop-densest-as-needed --force `
    /work/coverage.geojsonl
  if ($LASTEXITCODE -ne 0) { throw "tippecanoe failed." }

  # Atomic install: the server is live and serving byte ranges out of this file
  # right now, so it must never see a half-written one.
  Write-Host "== Installing =="
  docker run --rm -v "${Volume}:/tiles" -v "${WorkDir}:/work:ro" alpine sh -c `
    "cp /work/$ArchiveName /tiles/$ArchiveName.tmp && mv /tiles/$ArchiveName.tmp /tiles/$ArchiveName && cp /work/cell-signal-cells.json /tiles/cell-signal-cells.json.tmp && mv /tiles/cell-signal-cells.json.tmp /tiles/cell-signal-cells.json"
  if ($LASTEXITCODE -ne 0) { throw "installing the archive onto $Volume failed." }

  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Set-Manifest -AsOfDate $asOf -LastSuccess $now -LastError $null
  Write-Host "Done. $ArchiveName installed on $Volume (as of $asOf)."
}
catch {
  # Record and rethrow: the manifest is what makes a silently failing scheduled
  # task visible, and the non-zero exit is what makes Task Scheduler show it.
  $message = $_.Exception.Message
  Set-Manifest -AsOfDate $(if ($installed) { $installed.asOfDate } else { $null }) `
    -LastSuccess $previousSuccess -LastError $message
  Write-Error "Cell signal refresh failed: $message"
  exit 1
}
