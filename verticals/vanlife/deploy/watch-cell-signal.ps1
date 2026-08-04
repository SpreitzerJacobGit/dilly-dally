# Dilly-Dally cell signal host agent (authored — the generator never touches this).
#
# Carries out refreshes the app asks for. The app runs in a container with no
# Docker socket and no view of this repo, so it cannot run the pipeline itself;
# what it CAN do is write a file onto the internal data volume, which is the
# only private channel the two share. The tiles volume is not an option: the
# app serves it at /tiles/ and its status route publishes every *.json sitting
# in it, so a credential there would be handed to anyone on the van's wifi.
#
# Four files in /data/cell-signal on the data volume:
#   fcc-token.json  app  -> host   credentials, written when they are saved
#   request.json    app  -> host   {requestId, requestedAt, requestedBy, force}
#   status.json     host -> app    what happened to the run with that requestId
#   watcher.json    host -> app    proof this agent is polling, written EVERY poll
#
# watcher.json is the one that earns its keep. Without it, an app waiting on a
# request it never gets an answer to cannot tell "the agent was never
# installed" from "the agent died on Tuesday" — different causes, different
# fixes. Writing it on idle polls too is the whole point: an agent that only
# announces itself while working is indistinguishable from one that is absent.
#
# Registered by install-cell-signal-schedule.ps1. Run it by hand to watch it:
#   pwsh -File verticals/vanlife/deploy/watch-cell-signal.ps1 -Once -Verbose
# -Once is exactly what the scheduled task runs, so that is the real path and
# not a debug one.
param(
  # NOT "vanlife-data" — see the comment on the same parameter in
  # refresh-cell-signal.ps1. A wrong name here fails silently forever.
  [string]$DataVolume = "vanlife_vanlife-data",
  [string]$RefreshScript = (Join-Path $PSScriptRoot "refresh-cell-signal.ps1"),
  [int]$PollSeconds = 300,
  [string]$LogDir = (Join-Path $PSScriptRoot "../../../.data-src/cell-signal/runs"),
  [string]$OutboxFile = (Join-Path $PSScriptRoot "../../../.data-src/cell-signal/pending-status.json"),
  # What the scheduled task uses: poll, supervise any work to completion, exit.
  # A fresh process every few minutes is the cheapest recovery there is from any
  # state a poller can wedge itself into. Without it the script loops, which is
  # what you want when running it by hand in a console.
  [switch]$Once
)
$ErrorActionPreference = "Stop"

$dockerBin = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (Test-Path (Join-Path $dockerBin "docker.exe")) { $env:PATH = "$dockerBin;$env:PATH" }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$Dir = "/data/cell-signal"

# Local\ rather than Global\: creating a global kernel object needs
# SeCreateGlobalPrivilege, which the Limited interactive principal the task runs
# under does not have. The cost is that two simultaneous interactive sessions
# could each run an agent — not a van-server scenario, and noted as unhandled.
#
# A mutex rather than a lock file because it is released when the process dies
# INCLUDING a hard kill or a reboot, which is exactly the case a lock file gets
# wrong.
$mutex = New-Object System.Threading.Mutex($false, "Local\DillyDally.CellSignalWatcher")
if (-not $mutex.WaitOne(0)) {
  Write-Verbose "Another watcher holds the lock; nothing to do."
  exit 0
}

function Now-Iso { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

function To-B64([string]$Text) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
}

# The single most important property of this script: a poll may fail for any
# reason and the agent keeps polling. $ErrorActionPreference is Stop for
# everything else, which is what used to make refresh-cell-signal.ps1 die
# uncatchably when the daemon was missing. Nothing in this loop inherits that.
function Invoke-Data([string]$Sh) {
  try {
    $out = docker run --rm -v "${DataVolume}:/data" alpine sh -c $Sh 2>&1
    if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Err = ($out | Out-String).Trim() } }
    return @{ Ok = $true; Out = ($out | Out-String) }
  } catch {
    return @{ Ok = $false; Err = $_.Exception.Message }
  }
}

function Test-DataVolume {
  try {
    docker volume inspect $DataVolume 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function From-B64Json([string]$B64) {
  if ([string]::IsNullOrWhiteSpace($B64)) { return $null }
  try {
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64.Trim())) | ConvertFrom-Json
  } catch { return $null }
}

# Heartbeat out and both state files back in ONE container. Each docker run on
# Windows costs the better part of a second and is another chance for the daemon
# to vanish mid-poll leaving the volume half-updated.
#
# Writes go through tmp+mv because the app reads these with plain fs, on the
# same volume, possibly mid-write — the same reason refresh-cell-signal.ps1
# installs the archive with cp-then-mv while the server is serving out of it.
# $Heartbeat is untyped rather than [hashtable] because callers pass [ordered]
# dictionaries, which are OrderedDictionary and would not coerce.
function Sync-Volume($Heartbeat, [string]$StatusJson) {
  $hb = To-B64 (($Heartbeat | ConvertTo-Json -Compress))
  $lines = @(
    "mkdir -p $Dir",
    "echo $hb | base64 -d > $Dir/watcher.json.tmp && mv $Dir/watcher.json.tmp $Dir/watcher.json"
  )
  if ($StatusJson) {
    $st = To-B64 $StatusJson
    $lines += "echo $st | base64 -d > $Dir/status.json.tmp && mv $Dir/status.json.tmp $Dir/status.json"
  }
  $lines += "echo '--REQUEST--'; base64 < $Dir/request.json 2>/dev/null | tr -d '\n'; echo"
  $lines += "echo '--STATUS--';  base64 < $Dir/status.json  2>/dev/null | tr -d '\n'; echo"
  $res = Invoke-Data ($lines -join "`n")
  if (-not $res.Ok) { return @{ Ok = $false; Err = $res.Err } }

  $text = $res.Out -split "`r?`n"
  $reqB64 = ""; $stB64 = ""; $mode = ""
  foreach ($line in $text) {
    if ($line -match '^--REQUEST--') { $mode = "req"; continue }
    if ($line -match '^--STATUS--') { $mode = "st"; continue }
    if ($mode -eq "req" -and $line.Trim()) { $reqB64 = $line.Trim() }
    if ($mode -eq "st" -and $line.Trim()) { $stB64 = $line.Trim() }
  }
  return @{ Ok = $true; Request = (From-B64Json $reqB64); Status = (From-B64Json $stB64) }
}

function New-Status([hashtable]$Fields) {
  $base = [ordered]@{
    schema      = 1
    requestId   = $null
    trigger     = "app"
    force       = $false
    state       = "running"
    startedAt   = $null
    heartbeatAt = Now-Iso
    finishedAt  = $null
    exitCode    = $null
    error       = $null
    step        = $null
    pid         = $null
    host        = $env:COMPUTERNAME
  }
  foreach ($k in $Fields.Keys) { $base[$k] = $Fields[$k] }
  return ($base | ConvertTo-Json -Compress)
}

# A run that finishes while Docker is down has nowhere to record its result,
# and the result is the thing that matters most. Terminal statuses are written
# host-side first and flushed on later polls until one lands, which turns a
# Docker outage from "lost" into "eventually consistent".
function Save-Outbox([string]$Json) {
  $dir = Split-Path $OutboxFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $OutboxFile -Value $Json -Encoding utf8
}
function Read-Outbox {
  if (-not (Test-Path $OutboxFile)) { return $null }
  return (Get-Content $OutboxFile -Raw)
}
function Clear-Outbox {
  if (Test-Path $OutboxFile) { Remove-Item $OutboxFile -Force }
}

# The one guard the mutex cannot give: refresh-cell-signal.ps1 is launched as
# an independent process and SURVIVES this agent being killed. A fresh agent
# must not start a second multi-gigabyte build alongside an orphan.
function Test-RefreshRunning {
  $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
  return @($procs | Where-Object { $_.CommandLine -like "*refresh-cell-signal.ps1*" }).Count -gt 0
}

function Get-Step([string]$LogPath) {
  if (-not (Test-Path $LogPath)) { return $null }
  $banner = Select-String -Path $LogPath -Pattern '^==\s*(.+?)\s*==$' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
  if ($banner) { return $banner.Matches[0].Groups[1].Value }
  return $null
}

function Get-Tail([string]$LogPath, [int]$Count) {
  if (-not (Test-Path $LogPath)) { return "" }
  $lines = @(Get-Content $LogPath -Tail $Count -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
  return ($lines -join " / ")
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
# Keep the last ten runs. Nothing rotates mid-run; a pathological refresh can
# still write a large log.
Get-ChildItem $LogDir -Filter "*.log" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 |
  Remove-Item -Force -ErrorAction SilentlyContinue

$script:ClaimedRequestId = $null

try {
  while ($true) {
    $pollError = $null
    $busy = $false

    if (-not (Test-DataVolume)) {
      # Cannot even report this — the channel is the volume. Say it locally and
      # try again; the app will show "no host agent has responded", which is
      # the honest reading from its side.
      Write-Warning "Volume '$DataVolume' not found. Is the stack up? (docker volume ls)"
      if ($Once) { break }
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    $pending = Read-Outbox
    $heartbeat = [ordered]@{
      schema        = 1
      aliveAt       = Now-Iso
      pollSeconds   = $PollSeconds
      busy          = $false
      host          = $env:COMPUTERNAME
      script        = "watch-cell-signal.ps1"
      lastPollError = $null
    }

    $sync = Sync-Volume -Heartbeat $heartbeat -StatusJson $pending
    if (-not $sync.Ok) {
      Write-Warning "Poll failed: $($sync.Err)"
      if ($Once) { break }
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    # It landed, so the outbox has done its job.
    if ($pending) { Clear-Outbox }

    $req = $sync.Request
    $st = $sync.Status

    # A reboot or a kill mid-run leaves status.json saying "running" forever.
    # The mutex proves no other WATCHER is alive, but not that the refresh it
    # launched is dead — so check, and match on start time too because Windows
    # reuses process ids freely.
    if ($st -and $st.state -eq "running" -and $st.requestId -ne $script:ClaimedRequestId) {
      $orphanAlive = Test-RefreshRunning
      if (-not $orphanAlive) {
        $interrupted = New-Status @{
          requestId  = $st.requestId
          state      = "interrupted"
          startedAt  = $st.startedAt
          finishedAt = (Now-Iso)
          # Plain hyphens, not an em dash: Windows PowerShell 5.1 reads this
          # file as ANSI, where the em dash's UTF-8 bytes end in 0x94 - a curly
          # quote that closes the string and breaks the parse.
          error      = "The refresh was interrupted - the van server stopped while it was running, through a reboot, a sign-out, or the task's execution time limit."
        }
        $flush = Sync-Volume -Heartbeat $heartbeat -StatusJson $interrupted
        if (-not $flush.Ok) { Save-Outbox $interrupted }
        # Claimed so it is not re-run on the operator's behalf. A multi-hour job
        # they did not ask for twice is not ours to start.
        $script:ClaimedRequestId = $st.requestId
        $st = $null
      } else {
        Write-Verbose "A refresh is already running outside this agent; leaving it alone."
        $busy = $true
      }
    }

    $requestId = $null
    if ($req -and $req.requestId) { $requestId = [string]$req.requestId }
    elseif ($req) {
      # A hand-written request with no id would otherwise be claimed afresh on
      # every poll. Derive one from the content so it runs exactly once.
      $bytes = [Text.Encoding]::UTF8.GetBytes(($req | ConvertTo-Json -Compress))
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $requestId = "anon-" + [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").Substring(0, 16)
      } finally { $sha.Dispose() }
    }

    $alreadyDone = $st -and $st.requestId -eq $requestId
    $claimable = $requestId -and -not $busy -and $requestId -ne $script:ClaimedRequestId -and -not $alreadyDone

    if ($claimable -and (Test-RefreshRunning)) {
      Write-Verbose "A refresh is already running; not starting another."
      $claimable = $false
    }

    if ($claimable) {
      $script:ClaimedRequestId = $requestId
      $startedAt = Now-Iso
      $safeId = ($requestId -replace '[^A-Za-z0-9._-]', '_')
      $outLog = Join-Path $LogDir "$safeId.out.log"
      $errLog = Join-Path $LogDir "$safeId.err.log"

      # Shelling out rather than dot-sourcing or reimplementing. That script IS
      # the pipeline and a second copy would drift; a separate process gives a
      # real exit code and a real kill boundary (the refresh calls `exit 1`,
      # which in-process would take this agent down with it); and this agent has
      # to stay responsive for HOURS to keep heartbeating, which needs a process
      # it can poll rather than a call it is blocked inside.
      $argList = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $RefreshScript, "-DataVolume", $DataVolume
      )
      if ($req.force) { $argList += "-Force" }

      Write-Host "Starting refresh for $requestId"
      # -WorkingDirectory is load-bearing: the refresh runs `pnpm exec tsx` for
      # its aggregation step and needs the workspace.
      $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $argList `
        -WorkingDirectory $RepoRoot -NoNewWindow -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
      # UNVERIFIED, and a classic trap: a -PassThru process can report a null
      # ExitCode later unless its handle is cached while it is still open.
      $null = $proc.Handle

      $running = New-Status @{
        requestId = $requestId; state = "running"; startedAt = $startedAt
        force = [bool]$req.force; pid = $proc.Id
      }
      $push = Sync-Volume -Heartbeat $heartbeat -StatusJson $running
      if (-not $push.Ok) { Write-Warning "Could not publish the running state: $($push.Err)" }

      # Supervise. The heartbeat here is what tells the app this run is alive,
      # as distinct from watcher.json telling it the agent is.
      while (-not $proc.HasExited) {
        Start-Sleep -Seconds $PollSeconds
        $hb = [ordered]@{
          schema = 1; aliveAt = (Now-Iso); pollSeconds = $PollSeconds
          busy = $true; host = $env:COMPUTERNAME; script = "watch-cell-signal.ps1"; lastPollError = $null
        }
        $tick = New-Status @{
          requestId = $requestId; state = "running"; startedAt = $startedAt
          force = [bool]$req.force; pid = $proc.Id; step = (Get-Step $outLog)
        }
        $res = Sync-Volume -Heartbeat $hb -StatusJson $tick
        if (-not $res.Ok) { Write-Warning "Heartbeat failed: $($res.Err)" }
      }

      $code = $proc.ExitCode
      $errText = (Get-Tail $errLog 10)
      if ($errText.Length -gt 500) { $errText = $errText.Substring(0, 500) }
      # Computed up front: Windows PowerShell 5.1 cannot parse an `if`
      # expression as a hash literal value, and the scheduled task runs 5.1.
      $finalState = "failed"
      $finalError = $errText
      if ($code -eq 0) {
        $finalState = "succeeded"
        $finalError = $null
      } elseif (-not $errText) {
        $finalError = "the refresh exited $code with no error output"
      }
      $final = New-Status @{
        requestId  = $requestId
        state      = $finalState
        startedAt  = $startedAt
        finishedAt = (Now-Iso)
        exitCode   = $code
        force      = [bool]$req.force
        step       = (Get-Step $outLog)
        error      = $finalError
      }
      $doneHb = [ordered]@{
        schema = 1; aliveAt = (Now-Iso); pollSeconds = $PollSeconds
        busy = $false; host = $env:COMPUTERNAME; script = "watch-cell-signal.ps1"; lastPollError = $null
      }
      $land = Sync-Volume -Heartbeat $doneHb -StatusJson $final
      if (-not $land.Ok) {
        Write-Warning "Could not publish the result; holding it for the next poll."
        Save-Outbox $final
      }
      Write-Host "Refresh $requestId finished with exit code $code"
    }

    if ($Once) { break }
    Start-Sleep -Seconds $PollSeconds
  }
}
finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
