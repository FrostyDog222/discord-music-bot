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
  Write-Host "`n==> Bot token (Discord Developer Portal -> Bot -> Reset Token):" -ForegroundColor Cyan
  $token = Read-Host "Paste your bot TOKEN"
  "TOKEN=$token" | Set-Content -Encoding ASCII .env
  Write-Host ".env created." -ForegroundColor Green
} else {
  Write-Host "`n.env already exists - leaving it alone." -ForegroundColor Yellow
}

$ans = Read-Host "`nAuto-start + keep-alive at login, and daily yt-dlp update? (y/n)"
if ($ans -eq 'y') {
  # Watchdog: runs at login and every 5 min, (re)starting the bot if it's not
  # running (unless deliberately stopped via the dashboard). Self-heals crashes.
  $vbs = Join-Path $PSScriptRoot 'watchdog-hidden.vbs'  # runs the watchdog with NO window
  $a1 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
  $t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $t1b = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $s1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'Discord Music Bot' -Action $a1 -Trigger @($t1, $t1b) -Settings $s1 -Force | Out-Null

  $a2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "winget upgrade --id yt-dlp.yt-dlp --silent --accept-source-agreements --accept-package-agreements"'
  $t2 = New-ScheduledTaskTrigger -Daily -At 5am
  $s2 = New-ScheduledTaskSettingsSet -StartWhenAvailable
  Register-ScheduledTask -TaskName 'yt-dlp daily update' -Action $a2 -Trigger $t2 -Settings $s2 -Force | Out-Null
  Write-Host "Scheduled tasks created." -ForegroundColor Green
}

Write-Host "`n=== Setup complete! ===" -ForegroundColor Green
Write-Host "Note: this setup does NOT start or stop the bot." -ForegroundColor Yellow
Write-Host "To start it now: run 'Music Bot.bat' and choose [1] Start."
Write-Host "Or, if you enabled auto-start, it launches on its own at your next login."
Write-Host "(Re-running this setup is safe - it won't touch a running bot or your .env.)"
Read-Host "`nPress Enter to exit"
