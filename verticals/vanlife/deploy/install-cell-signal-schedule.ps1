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
param(
  [string]$TaskName = "Dilly-Dally cell signal refresh",
  [string]$DayOfWeek = "Sunday",
  [string]$At = "03:30",
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
  -ExecutionTimeLimit (New-TimeSpan -Hours 6)
# -StartWhenAvailable is the load-bearing one: this box will not be powered on
# continuously, and without it a run missed while it was off is simply skipped
# rather than caught up at the next opportunity.

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $LogonType -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered '$TaskName' — $DayOfWeek at $At, catching up if the machine was off."
Write-Host ""
Write-Host "Run it now:        Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check the result:  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Remove it:         Unregister-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "The first build must be run by hand — it needs FCC credentials in place:"
Write-Host "  pwsh -File `"$script`" -Force"
