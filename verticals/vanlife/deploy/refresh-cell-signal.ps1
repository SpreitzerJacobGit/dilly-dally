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
# Credentials come from the app by default — Settings → Cell coverage writes
# them onto the internal data volume, which is the only private channel the
# container has (the tiles volume is served over HTTP, so a token can never go
# there). The repo-root .fcc-token still works and is what you want before the
# app is even up. Precedence is in Get-FccAuthHeaders.
#
# One-time setup, if you would rather not use the app:
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
  # The app's private channel to the host. NOT "vanlife-data": compose.yaml
  # declares it without `external:`, so Compose prefixes it with the project
  # name, and vanlife-tiles/vanlife-osrm keep their literal names only because
  # they ARE external. Getting this wrong is silent — `docker run -v <name>`
  # CREATES a volume that does not exist rather than failing, and everything
  # downstream then reads an empty directory forever.
  [string]$DataVolume = "vanlife_vanlife-data",
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

# Whether the caller named a token file explicitly. Captured here because
# $PSBoundParameters is not visible from inside a function.
$TokenFileWasGiven = $PSBoundParameters.ContainsKey('TokenFile')

# Docker Desktop does not put its bin directory on PATH for non-interactive
# shells, and the credential helper lives there too — without it every pull
# fails with "error getting credentials" rather than anything about Docker.
# This script is the one that actually runs unattended, so it needs this more
# than prepare-legal-overlay.ps1 does.
$dockerBin = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (Test-Path (Join-Path $dockerBin "docker.exe")) { $env:PATH = "$dockerBin;$env:PATH" }

# Pre-flight rather than discovering it at the first docker call. Get-InstalledManifest
# used to run before the try block below, so a missing daemon killed the script
# where nothing could record it — the one failure the app could never see.
function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found. Install Docker Desktop, or add its resources\bin to PATH."
  }
  docker volume inspect $Volume 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "The tiles volume '$Volume' does not exist. Run prepare-data.ps1 first, and check the Docker daemon is running."
  }
}

# The weekly task and an app-triggered run are different scheduled tasks, so
# -MultipleInstances cannot keep them apart. Nothing stopped a hand-run
# colliding with the weekly task either.
function Test-RefreshRunning {
  $me = $PID
  $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
  return @($procs | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like "*refresh-cell-signal.ps1*" }).Count -gt 0
}

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

# Pulls the credentials the app saved, without ever putting them on host disk.
#
# Deliberately no temp file: Task Scheduler kills a run at its execution time
# limit without running `finally`, and so does a reboot, so a temp file holding
# an API token is a secret with no reliable cleanup. base64 straight into
# memory instead — the same trick Set-Manifest uses in the other direction.
# Only the path crosses on the command line; the secret comes back on stdout.
#
# `base64 | tr -d '\n'` rather than `base64 -w0`: busybox does not carry -w in
# every build, and this only ever runs against alpine.
function Get-VolumeToken {
  docker volume inspect $DataVolume 2>&1 | Out-Null
  # $null rather than throwing: "the app has never saved credentials" is an
  # ordinary state and the caller falls through to the file.
  if ($LASTEXITCODE -ne 0) { return $null }
  $b64 = docker run --rm -v "${DataVolume}:/data" alpine `
    sh -c "base64 < /data/cell-signal/fcc-token.json 2>/dev/null | tr -d '\n'"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($b64)) { return $null }
  try {
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64.Trim())) | ConvertFrom-Json
  } catch {
    # A corrupt file must not read as "no credentials" — that would send the
    # operator to Settings to re-enter a token that is already there. Name it.
    throw "The FCC credentials on $DataVolume (/data/cell-signal/fcc-token.json) are not valid JSON. Re-save them in Settings."
  }
}

function Get-FccAuthHeaders {
  $creds = $null
  $source = $null
  # The app wins over the repo-root file when both exist — it is the newer
  # decision — unless -TokenFile was passed explicitly, in which case the
  # operator has named a file and means it.
  if (-not $TokenFileWasGiven) {
    $creds = Get-VolumeToken
    if ($creds) { $source = "the app (Settings -> Cell coverage)" }
  }
  if (-not $creds -and (Test-Path $TokenFile)) {
    $creds = Get-Content $TokenFile -Raw | ConvertFrom-Json
    $source = $TokenFile
  }
  if (-not $creds) {
    # This string reaches three places someone might be looking: the tiles
    # manifest, the watcher's status.json (so the Settings page shows it right
    # where the button was pressed), and Task Scheduler's last result. Name
    # both places it looked and both ways to fix it.
    throw ("No FCC credentials. The app has saved none to $DataVolume " +
      "(/data/cell-signal/fcc-token.json), and there is no file at $TokenFile. " +
      "Add them in the app under Settings -> Cell coverage, or create that file " +
      "as {`"username`":`"...`",`"token`":`"...`"}.")
  }
  if (-not $creds.username -or -not $creds.token) {
    throw "The FCC credentials from $source must contain both 'username' and 'token'."
  }
  Write-Host "Using FCC credentials from $source."
  # Remembered so anything written to the manifest or to stderr can be scrubbed
  # of it first. Nothing here is known to echo a header, but an error message is
  # the one string in this script that travels to a browser.
  $script:TokenSecret = $creds.token
  # UNVERIFIED header names — the BDC API authenticates with the registered
  # username plus the token, not a bearer header.
  return @{ "username" = $creds.username; "hash_value" = $creds.token }
}

function Remove-Secret([string]$Text) {
  if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($script:TokenSecret)) { return $Text }
  return $Text.Replace($script:TokenSecret, "***")
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

# Pre-initialised so the catch block can still write a manifest even when the
# failure happened before either was read.
$installed = $null
$previousSuccess = $null

try {
  Assert-Docker

  if (Test-RefreshRunning) {
    # Exit 0, not 1: another refresh already doing the work is the desired end
    # state, not a fault worth alarming anyone about.
    Write-Host "Another refresh is already running; leaving it alone."
    exit 0
  }

  $installed = Get-InstalledManifest
  $previousSuccess = if ($installed) { $installed.lastSuccess } else { $null }

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

  # watch-cell-signal.ps1 scrapes lines of the form "== ... ==" to report which
  # step a run is on. Renaming them degrades that display to "running" and
  # breaks nothing else.
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
  & pnpm exec tsx (Join-Path $PSScriptRoot "build-cell-signal.ts") `
    --in $csv --out $geojson --parent-res $ParentRes @providersArg
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
    "cp /work/$ArchiveName /tiles/$ArchiveName.tmp && mv /tiles/$ArchiveName.tmp /tiles/$ArchiveName"
  if ($LASTEXITCODE -ne 0) { throw "installing the archive onto $Volume failed." }

  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Set-Manifest -AsOfDate $asOf -LastSuccess $now -LastError $null
  Write-Host "Done. $ArchiveName installed on $Volume (as of $asOf)."
}
catch {
  # Record and rethrow: the manifest is what makes a silently failing scheduled
  # task visible, and the non-zero exit is what makes Task Scheduler show it.
  $message = Remove-Secret $_.Exception.Message
  # Best effort: if the failure WAS Docker, this cannot land either, and the
  # watcher's status.json is the only place the operator will see it.
  try {
    Set-Manifest -AsOfDate $(if ($installed) { $installed.asOfDate } else { $null }) `
      -LastSuccess $previousSuccess -LastError $message
  } catch {
    Write-Host "Could not record the failure on $Volume - Docker is likely unreachable."
  }
  Write-Error "Cell signal refresh failed: $message"
  exit 1
}
