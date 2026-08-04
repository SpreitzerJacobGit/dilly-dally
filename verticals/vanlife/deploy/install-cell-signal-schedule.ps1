# Registers the scheduled task that keeps the cell signal overlay current.
# Run once, on the machine that runs the compose stack. Re-running replaces the
# existing task.
#
#   pwsh -File verticals/vanlife/deploy/install-cell-signal-schedule.ps1
#
# The task just runs refresh-cell-signal.ps1, which checks the FCC's current
# availability date before doing any work — so a run that finds nothing new
# costs one API call and a few seconds. That is what makes a frequent schedule
# affordable, and a frequent schedule is what stops the overlay going stale
# without anyone noticing.
#
# Registers TWO tasks. The weekly refresh is the safety net that keeps the
# overlay current unattended. The watcher is what makes the app's "Refresh now"
# button do anything: the app runs in a container with no Docker socket, so it
# writes a request onto the data volume and this polls for it.
#
# They are kept separate deliberately. Routing the weekly run through the
# watcher would be tidier, but it would mean the overlay silently stops
# updating whenever the watcher is broken - trading an independent safety net
# for tidiness.
param(
  [string]$TaskName = "Dilly-Dally cell signal refresh",
  [string]$WatcherTaskName = "Dilly-Dally cell signal watcher",
  [string]$DayOfWeek = "Sunday",
  [string]$At = "03:30",
  [int]$PollMinutes = 5,
  [switch]$SkipWatcher,
  # Interactive by default because Docker Desktop generally is not running when
  # nobody is logged on, and a task that runs but cannot reach Docker would
  # write a failure into the manifest every week. Switch to S4U only if the
  # Docker daemon on this host genuinely runs headless.
  [ValidateSet("Interactive", "S4U")]
  [string]$LogonType = "Interactive"
)
$ErrorActionPreference = "Stop"

$script = (Resolve-Path (Join-Path $PSScriptRoot "refresh-cell-signal.ps1")).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory $repoRoot

# Weekly rather than monthly: New-ScheduledTaskTrigger supports it directly
# where monthly needs hand-built CIM objects, the check is nearly free, and it
# means a new FCC release is picked up within a week instead of within a month.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $At

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6)
# -StartWhenAvailable is the load-bearing one: this box will not be powered on
# continuously, and without it a run missed while it was off is simply skipped
# rather than caught up at the next opportunity.
#
# The battery flags are not optional on a van. New-ScheduledTaskSettingsSet
# defaults to refusing to start on DC power AND to stopping a running task the
# moment the machine switches to it, so a mini-PC behind an inverter that
# reports DC can silently never run this at all.

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $LogonType -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered '$TaskName' - $DayOfWeek at $At, catching up if the machine was off."
Write-Host ""
Write-Host "Run it now:        Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check the result:  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Remove it:         Unregister-ScheduledTask -TaskName '$TaskName'"

if (-not $SkipWatcher) {
  $watchScript = (Resolve-Path (Join-Path $PSScriptRoot "watch-cell-signal.ps1")).Path

  $wAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$watchScript`" -Once -PollSeconds $($PollMinutes * 60)" `
    -WorkingDirectory $repoRoot

  # A repeating trigger rather than one long-lived process: a fresh process
  # every few minutes is the cheapest recovery there is from any state a poller
  # can wedge itself into. -Once plus .Repetition is the standard incantation
  # because New-ScheduledTaskTrigger has no -RepetitionInterval parameter.
  #
  # UNVERIFIED: that .Repetition survives Register-ScheduledTask under a Limited
  # principal. Check with Get-ScheduledTask after the first install.
  $wTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
  $wTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
      -RepetitionInterval (New-TimeSpan -Minutes $PollMinutes) `
      -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
  # Plus a logon trigger, because the machine gets rebooted and an interactive
  # principal is the only one that runs at all.
  $wLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

  # Deliberately NOT -RunOnlyIfNetworkAvailable, which the weekly refresh does
  # set. A watcher with no uplink still has a job: write the heartbeat, so the
  # app can say "the refresh failed for want of a network" rather than "no host
  # agent has responded". Reporting is exactly what has to survive the outage.
  #
  # 8h rather than the refresh task's 6h: this limit covers a poll PLUS
  # supervising a full rebuild, and killing the watcher mid-refresh orphans the
  # child and leaves a stale "running" for the next start to clean up.
  $wSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 8)

  Register-ScheduledTask -TaskName $WatcherTaskName -Action $wAction -Trigger @($wTrigger, $wLogon) `
    -Settings $wSettings -Principal $principal -Force | Out-Null

  Write-Host ""
  Write-Host "Registered '$WatcherTaskName' - every $PollMinutes minutes, and at logon."
  Write-Host "This is what makes Settings -> Cell coverage -> 'Refresh now' do anything."
  Write-Host ""
  Write-Host "Run it now:        Start-ScheduledTask -TaskName '$WatcherTaskName'"
  Write-Host "Check the result:  Get-ScheduledTaskInfo -TaskName '$WatcherTaskName'"
  Write-Host "Remove it:         Unregister-ScheduledTask -TaskName '$WatcherTaskName'"
  Write-Host "Watch it by hand:  pwsh -File `"$watchScript`" -Once -Verbose"
}

Write-Host ""
Write-Host "Both tasks run as $env:USERDOMAIN\$env:USERNAME with LogonType $LogonType."
if ($LogonType -eq "Interactive") {
  Write-Host "That means NEITHER runs while nobody is signed in to this machine."
  Write-Host "For a van server, enable auto sign-in and leave it at a locked screen:"
  Write-Host "a locked session is still signed in, so both tasks keep running."
}
Write-Host ""
Write-Host "Credentials come from the app (Settings -> Cell coverage) by default."
Write-Host "The first build must be run by hand once they are in place:"
Write-Host "  pwsh -File `"$script`" -Force"
