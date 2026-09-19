# Discord Music Bot - control panel.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# -EnableAutoStart: register the watchdog + yt-dlp update tasks and exit (used by setup.ps1).
param([switch]$EnableAutoStart)
Set-Location -LiteralPath $PSScriptRoot

$BotJs    = Join-Path $PSScriptRoot 'bot.js'
$StopFlag = Join-Path $PSScriptRoot '.stopped'
$TaskName = 'Discord Music Bot'
$UpdTask  = 'yt-dlp daily update'
$Vbs      = Join-Path $PSScriptRoot 'watchdog-hidden.vbs'
$ConfigFile = Join-Path $PSScriptRoot 'config.json'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine')
}

# This folder's bot only (absolute path, or a bare "node bot.js") - never unrelated node apps.
function Get-Bot {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $c = $_.CommandLine  # paths are case-insensitive on Windows
    $c -and ($c.IndexOf($BotJs, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $c -match '\s"?bot\.js"?\s*$')
  }
}

function Start-Bot {
  Remove-Item -LiteralPath $StopFlag -ErrorAction SilentlyContinue  # clear the "deliberately stopped" flag
  # The watchdog does the real work: PATH refresh, log rotation, one-launcher lock, already-running check.
  & (Join-Path $PSScriptRoot 'watchdog.ps1')
  for ($i = 0; $i -lt 10 -and -not (Get-Bot); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep 3  # give it a moment to crash if it's going to (bad token, missing file...)
  if (Get-Bot) { Write-Host "Started." -ForegroundColor Green; return $true }
  Write-Host "The bot did not stay running. Last errors (bot.err):" -ForegroundColor Red
  Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bot.err') -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  $null = Read-Host "`nPress Enter"  # $null: otherwise the typed text becomes part of the return value
  return $false
}

function Stop-Bot {
  [IO.File]::WriteAllText($StopFlag, '')  # tell the watchdog to leave it stopped (until reboot or Start)
  # /T also ends the bot's yt-dlp/ffmpeg and keep-awake helper, so nothing is left behind.
  Get-Bot | ForEach-Object { taskkill /PID $_.ProcessId /T /F *> $null }
}

function Get-AutoStart {
  # ON only if the task exists AND points at this folder (a moved folder leaves a dead task behind).
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  [bool]$t -and "$($t.Actions[0].Arguments)".IndexOf($Vbs, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Register-UpdateTask {
  # yt-dlp's own updater (nightly = what yt-dlp recommends for YouTube); winget lags weeks behind.
  # Retries so a run right after wake, before the network is up, isn't lost.
  $cmd = 'for($i=0;$i -lt 3;$i++){ yt-dlp --update-to nightly; if($LASTEXITCODE -eq 0){exit 0}; Start-Sleep 300 }; exit 1'
  # conhost --headless: no console window flashes on screen (-WindowStyle Hidden applies too late).
  $a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoProfile -Command "' + $cmd + '"')
  $t = New-ScheduledTaskTrigger -Daily -At 5am
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $UpdTask -Action $a -Trigger $t -Settings $s -Force | Out-Null
}

function Enable-AutoStart {
  # A watchdog task: runs at login AND every 5 minutes, (re)starting the bot if it isn't running,
  # so it self-heals no matter what killed it - unless it was deliberately stopped (.stopped flag).
  # wscript //B: no error dialog if the folder is ever moved.
  $a  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B "' + $Vbs + '"')
  $t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $s  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $a -Trigger @($t1, $t2) -Settings $s -Force | Out-Null
  Register-UpdateTask
  Remove-Item -LiteralPath $StopFlag -ErrorAction SilentlyContinue  # turning keep-alive on means "keep it running"
}
function Disable-AutoStart {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Get-KeepAwake {
  if (Test-Path -LiteralPath $ConfigFile) {
    try { return [bool](Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json).keepAwake } catch { return $true }
  }
  return $true  # default ON
}
function Set-KeepAwake($val) {
  # WriteAllText = UTF-8 without a BOM; PowerShell 5.1's -Encoding UTF8 adds one and the bot can't read it.
  [IO.File]::WriteAllText($ConfigFile, (@{ keepAwake = [bool]$val } | ConvertTo-Json))
}

function Get-InviteLink {
  # Prefer the link the bot itself printed; otherwise decode the app id from the token in .env.
  $logged = Select-String -LiteralPath (Join-Path $PSScriptRoot 'bot.log') -Pattern 'Invite link: (\S+)' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
  if ($logged) { return $logged.Matches[0].Groups[1].Value }
  $line = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env') -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^\s*TOKEN\s*=' } | Select-Object -First 1
  if (-not $line) { return $null }
  $b64 = ($line -replace '^\s*TOKEN\s*=\s*', '').Trim().Trim('"', "'").Split('.')[0].Replace('-', '+').Replace('_', '/')
  switch ($b64.Length % 4) { 2 { $b64 += '==' } 3 { $b64 += '=' } }
  try { $id = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } catch { return $null }
  if ($id -notmatch '^\d+$') { return $null }
  "https://discord.com/oauth2/authorize?client_id=$id&permissions=3148816&scope=bot+applications.commands"
}

Refresh-Path
if ($EnableAutoStart) { Enable-AutoStart; return }
while ($true) {
  Clear-Host
  Write-Host "================================"
  Write-Host "     Discord Music Bot"
  Write-Host "================================`n"
  if (Get-Bot) { Write-Host "  Status: RUNNING" -ForegroundColor Green }
  else {
    Write-Host "  Status: stopped" -ForegroundColor DarkGray
    if (Test-Path -LiteralPath $StopFlag) { Write-Host "  (stopped by you - the watchdog won't restart it until [1] Start or a reboot)" -ForegroundColor Yellow }
  }
  if (Get-AutoStart) { Write-Host "  Auto-start & keep-alive: [x] ON" -ForegroundColor Green }
  else               { Write-Host "  Auto-start & keep-alive: [ ] off" -ForegroundColor DarkGray }
  if (Get-KeepAwake) { Write-Host "  Keep PC awake:           [x] ON`n" -ForegroundColor Green }
  else               { Write-Host "  Keep PC awake:           [ ] off`n" -ForegroundColor DarkGray }
  Write-Host "  [1] Start bot"
  Write-Host "  [2] Stop bot"
  Write-Host "  [3] Restart bot"
  Write-Host "  [4] Update yt-dlp now  (use if YouTube songs stop playing)"
  Write-Host "  [5] Toggle auto-start & keep-alive"
  Write-Host "  [6] Toggle keep-PC-awake"
  Write-Host "  [7] Show invite link"
  Write-Host "  [8] Show recent errors"
  Write-Host "  [9] Exit  (bot keeps running)`n"
  switch (Read-Host "Choose") {
    '1' {
      if (Get-Bot) { Write-Host "Already running." -ForegroundColor Yellow; Start-Sleep 2 }
      else { if (Start-Bot) { Start-Sleep 2 } }
    }
    '2' { Stop-Bot; Write-Host "Stopped." -ForegroundColor Green; Start-Sleep 2 }
    '3' {
      Stop-Bot; Start-Sleep 1
      if (Start-Bot) { Write-Host "Restarted." -ForegroundColor Green; Start-Sleep 2 }
    }
    '4' {
      Refresh-Path
      yt-dlp --update-to nightly
      if ($LASTEXITCODE -eq 0) { Write-Host "`nyt-dlp is up to date." -ForegroundColor Green }
      else { Write-Host "`nUpdate failed (no internet?). Try again in a minute." -ForegroundColor Red }
      Read-Host "Press Enter"
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
      if (Get-Bot) { Stop-Bot; Start-Sleep 1; if (Start-Bot) { Write-Host "Restarted the bot to apply it." -ForegroundColor Green } }
      Start-Sleep 2
    }
    '7' {
      $link = Get-InviteLink
      if ($link) { Write-Host "`nInvite this bot to a server:`n$link" -ForegroundColor Cyan }
      else { Write-Host "`nCouldn't read the token from .env." -ForegroundColor Yellow }
      Read-Host "`nPress Enter"
    }
    '8' {
      foreach ($f in 'bot.err', 'bot.err.prev', 'watchdog.log') {
        Write-Host "`n--- $f ---" -ForegroundColor Cyan
        Get-Content -LiteralPath (Join-Path $PSScriptRoot $f) -Tail 12 -ErrorAction SilentlyContinue |
          Where-Object { $_ -notmatch 'DeprecationWarning|trace-deprecation' } | ForEach-Object { Write-Host "  $_" }
      }
      Read-Host "`nPress Enter"
    }
    '9' { exit }
  }
}
