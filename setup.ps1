# One-time setup for the Discord music bot on a new Windows PC.
# Run via Setup.bat (double-click). Assumes the repo files are already here.
Set-Location $PSScriptRoot

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Install-Pkg($id, $name) {
  Write-Host "==> Installing $name (skips if already present)..." -ForegroundColor Cyan
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
}

Write-Host "=== Discord Music Bot - setup ===`n"

Install-Pkg 'OpenJS.NodeJS.LTS' 'Node.js'
Install-Pkg 'Gyan.FFmpeg'       'ffmpeg'
Install-Pkg 'yt-dlp.yt-dlp'     'yt-dlp'
Refresh-Path

Write-Host "`n==> Installing bot dependencies..." -ForegroundColor Cyan
npm install

if (-not (Test-Path .env)) {
  Write-Host "`n==> Bot credentials (from the Discord Developer Portal):" -ForegroundColor Cyan
  $token = Read-Host "Paste your bot TOKEN"
  $guild = Read-Host "Paste your server (GUILD) ID"
  "TOKEN=$token`nGUILD_ID=$guild" | Set-Content -Encoding ASCII .env
  Write-Host ".env created." -ForegroundColor Green
} else {
  Write-Host "`n.env already exists - leaving it alone." -ForegroundColor Yellow
}

$ans = Read-Host "`nAuto-start the bot at login + daily yt-dlp update? (y/n)"
if ($ans -eq 'y') {
  $node = (Get-Command node).Source
  $a1 = New-ScheduledTaskAction -Execute $node -Argument 'bot.js' -WorkingDirectory $PSScriptRoot
  $t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $s1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'Discord Music Bot' -Action $a1 -Trigger $t1 -Settings $s1 -Force | Out-Null

  $a2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "winget upgrade --id yt-dlp.yt-dlp --silent --accept-source-agreements --accept-package-agreements"'
  $t2 = New-ScheduledTaskTrigger -Daily -At 5am
  $s2 = New-ScheduledTaskSettingsSet -StartWhenAvailable
  Register-ScheduledTask -TaskName 'yt-dlp daily update' -Action $a2 -Trigger $t2 -Settings $s2 -Force | Out-Null
  Write-Host "Scheduled tasks created." -ForegroundColor Green
}

Write-Host "`n=== Setup complete! ===" -ForegroundColor Green
Write-Host "Start it with 'Music Bot.bat', or it auto-starts at next login."
Read-Host "`nPress Enter to exit"
