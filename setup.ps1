# One-time setup for the Discord music bot on a new Windows PC.
# Run via "First Time Setup.bat" (double-click). Assumes the repo files are already here.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
Set-Location -LiteralPath $PSScriptRoot

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine')
}
function Fail($msg) {
  Write-Host "`n$msg" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "=== Discord Music Bot - setup ===`n"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail 'winget was not found. Install "App Installer" from the Microsoft Store, then run this again.'
}

function Install-Pkg($id, $name) {
  Write-Host "==> $name ..." -ForegroundColor Cyan
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --disable-interactivity
  # 0 = installed; 0x8A15002B = already installed / no newer version. Anything else is a real failure.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
    Fail "Installing $name failed (winget exit code $LASTEXITCODE). Fix that (or install it manually) and run this again."
  }
}

Install-Pkg 'OpenJS.NodeJS.LTS' 'Node.js'
Install-Pkg 'Gyan.FFmpeg'       'ffmpeg'
Install-Pkg 'yt-dlp.yt-dlp'     'yt-dlp'
Install-Pkg 'DenoLand.Deno'     'Deno (lets yt-dlp solve YouTube''s JS challenges)'
Refresh-Path

foreach ($c in 'node', 'npm', 'ffmpeg', 'yt-dlp') {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    Fail "$c is still missing after the install. Close this window, open 'First Time Setup.bat' again, or reboot and retry."
  }
}
$nodeVer = [version]((node --version) -replace '^v', '')
if ($nodeVer -lt [version]'22.12.0') {
  Fail "Node.js $nodeVer is too old (need 22.12 or newer). Update it: winget upgrade OpenJS.NodeJS.LTS"
}

Write-Host "`n==> Updating yt-dlp to the latest YouTube fixes..." -ForegroundColor Cyan
yt-dlp --update-to nightly

Write-Host "`n==> Installing bot dependencies..." -ForegroundColor Cyan
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed - see the messages above.' }

# A .env with an empty or missing TOKEN counts as missing.
$envFile = Join-Path $PSScriptRoot '.env'
$hasToken = (Test-Path -LiteralPath $envFile) -and
  (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*TOKEN\s*=\s*\S{20,}' })
if (-not $hasToken) {
  Write-Host "`n==> Bot token (Discord Developer Portal -> Bot -> Reset Token)." -ForegroundColor Cyan
  Write-Host "    It is hidden while you paste - just paste and press Enter."
  do {
    $sec = Read-Host 'Paste your bot TOKEN' -AsSecureString
    $token = ([Net.NetworkCredential]::new('', $sec).Password).Trim().Trim('"', "'") -replace '^TOKEN\s*=\s*', ''
    $ok = $token -match '^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$'
    if (-not $ok) { Write-Host "That doesn't look like a bot token - try again." -ForegroundColor Yellow }
  } until ($ok)
  [IO.File]::WriteAllText($envFile, "TOKEN=$token`r`n")  # ASCII token, no BOM
  Write-Host ".env created." -ForegroundColor Green
} else {
  Write-Host "`n.env already has a token - leaving it alone." -ForegroundColor Yellow
}

$ans = Read-Host "`nAuto-start + keep-alive at login, and daily yt-dlp update? (y/n)"
if ($ans -eq 'y') {
  & (Join-Path $PSScriptRoot 'dashboard.ps1') -EnableAutoStart
  Write-Host "Scheduled tasks created." -ForegroundColor Green
}

Write-Host "`n=== Setup complete! ===" -ForegroundColor Green
Write-Host "Note: this setup does NOT start or stop the bot." -ForegroundColor Yellow
Write-Host "To start it now: run 'Music Bot.bat' and choose [1] Start."
Write-Host "Or, if you enabled auto-start, it launches on its own at your next login (and within 5 minutes)."
Write-Host "(Re-running this setup is safe - it won't touch a running bot or your .env.)"
Read-Host "`nPress Enter to exit"
