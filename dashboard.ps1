# Discord Music Bot — control panel
Set-Location $PSScriptRoot

function Get-Bot {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bot.js*' }
}

function Start-Bot {
  # Detached + hidden: keeps running after this window closes.
  Start-Process node -ArgumentList 'bot.js' -WindowStyle Hidden
}

function Stop-Bot {
  Get-Bot | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

$TaskName = 'Discord Music Bot'
function Get-AutoStart {
  [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}
function Enable-AutoStart {
  # Launch the bot DETACHED so the Task Scheduler host tearing down can't kill it,
  # with ffmpeg/yt-dlp on PATH and logs captured.
  $dir = $PSScriptRoot
  $cmd = "`$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'+[Environment]::GetEnvironmentVariable('Path','Machine'); Set-Location '$dir'; Start-Process node -ArgumentList 'bot.js' -WindowStyle Hidden -RedirectStandardOutput '$dir\bot.log' -RedirectStandardError '$dir\bot.err'"
  $psArgs = '-NoProfile -WindowStyle Hidden -Command "' + $cmd + '"'
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
  $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $a -Trigger $t -Settings $s -Force | Out-Null
}
function Disable-AutoStart {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

$ConfigFile = Join-Path $PSScriptRoot 'config.json'
function Get-KeepAwake {
  if (Test-Path $ConfigFile) {
    try { return [bool](Get-Content $ConfigFile -Raw | ConvertFrom-Json).keepAwake } catch { return $true }
  }
  return $true  # default ON
}
function Set-KeepAwake($val) {
  (@{ keepAwake = [bool]$val } | ConvertTo-Json) | Set-Content $ConfigFile -Encoding UTF8
}

function Get-InviteLink {
  # The Application ID is the first token segment (base64url), so we can build
  # the invite link straight from .env — no hardcoded ID.
  $line = (Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -match '^TOKEN=' })
  if (-not $line) { return $null }
  $b64 = ($line -replace '^TOKEN=', '').Trim().Split('.')[0].Replace('-', '+').Replace('_', '/')
  switch ($b64.Length % 4) { 2 { $b64 += '==' } 3 { $b64 += '=' } }
  try { $id = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } catch { return $null }
  "https://discord.com/oauth2/authorize?client_id=$id&permissions=3148816&scope=bot+applications.commands"
}

while ($true) {
  Clear-Host
  Write-Host "================================"
  Write-Host "     Discord Music Bot"
  Write-Host "================================`n"
  if (Get-Bot) { Write-Host "  Status: RUNNING" -ForegroundColor Green }
  else         { Write-Host "  Status: stopped" -ForegroundColor DarkGray }
  if (Get-AutoStart) { Write-Host "  Auto-start at login: [x] ON" -ForegroundColor Green }
  else               { Write-Host "  Auto-start at login: [ ] off" -ForegroundColor DarkGray }
  if (Get-KeepAwake) { Write-Host "  Keep PC awake:       [x] ON`n" -ForegroundColor Green }
  else               { Write-Host "  Keep PC awake:       [ ] off`n" -ForegroundColor DarkGray }
  Write-Host "  [1] Start bot"
  Write-Host "  [2] Stop bot"
  Write-Host "  [3] Restart bot"
  Write-Host "  [4] Update yt-dlp now  (use if YouTube songs stop playing)"
  Write-Host "  [5] Toggle auto-start at login"
  Write-Host "  [6] Toggle keep-PC-awake"
  Write-Host "  [7] Show invite link"
  Write-Host "  [8] Exit  (bot keeps running)`n"
  switch (Read-Host "Choose") {
    '1' {
      if (Get-Bot) { Write-Host "Already running." -ForegroundColor Yellow }
      else { Start-Bot; Write-Host "Started." -ForegroundColor Green }
      Start-Sleep 2
    }
    '2' { Stop-Bot; Write-Host "Stopped." -ForegroundColor Green; Start-Sleep 2 }
    '3' {
      Stop-Bot; Start-Sleep 1; Start-Bot
      Write-Host "Restarted." -ForegroundColor Green; Start-Sleep 2
    }
    '4' {
      winget upgrade --id yt-dlp.yt-dlp --silent --accept-source-agreements --accept-package-agreements
      Read-Host "`nDone. Press Enter"
    }
    '5' {
      if (Get-AutoStart) { Disable-AutoStart; Write-Host "Auto-start turned OFF." -ForegroundColor Yellow }
      else { Enable-AutoStart; Write-Host "Auto-start turned ON." -ForegroundColor Green }
      Start-Sleep 2
    }
    '6' {
      $new = -not (Get-KeepAwake)
      Set-KeepAwake $new
      Write-Host ("Keep PC awake set to " + $(if ($new) { 'ON' } else { 'OFF' }) + ".") -ForegroundColor Green
      if (Get-Bot) { Stop-Bot; Start-Sleep 1; Start-Bot; Write-Host "Restarted the bot to apply it." -ForegroundColor Green }
      Start-Sleep 2
    }
    '7' {
      $link = Get-InviteLink
      if ($link) { Write-Host "`nInvite this bot to a server:`n$link" -ForegroundColor Cyan }
      else { Write-Host "`nCouldn't read the token from .env." -ForegroundColor Yellow }
      Read-Host "`nPress Enter"
    }
    '8' { exit }
  }
}
