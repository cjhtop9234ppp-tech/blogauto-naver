param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [string]$Execute,
  [string]$Arguments,
  [string]$WorkingDirectory,
  [string]$Time,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($Time, "HH:mm", $null))
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited
$action = New-ScheduledTaskAction `
  -Execute $Execute `
  -Argument $Arguments `
  -WorkingDirectory $WorkingDirectory

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Naver Blog Automator daily workflow" `
  -Force | Out-Null
