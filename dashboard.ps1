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
  $node = (Get-Command node).Source
  $a = New-ScheduledTaskAction -Execute $node -Argument 'bot.js' -WorkingDirectory $PSScriptRoot
  $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $a -Trigger $t -Settings $s -Force | Out-Null
}
function Disable-AutoStart {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

while ($true) {
  Clear-Host
  Write-Host "================================"
  Write-Host "     Discord Music Bot"
  Write-Host "================================`n"
  if (Get-Bot) { Write-Host "  Status: RUNNING" -ForegroundColor Green }
  else         { Write-Host "  Status: stopped" -ForegroundColor DarkGray }
  if (Get-AutoStart) { Write-Host "  Auto-start at login: [x] ON`n" -ForegroundColor Green }
  else               { Write-Host "  Auto-start at login: [ ] off`n" -ForegroundColor DarkGray }
  Write-Host "  [1] Start bot"
  Write-Host "  [2] Stop bot"
  Write-Host "  [3] Restart bot"
  Write-Host "  [4] Update yt-dlp now  (use if YouTube songs stop playing)"
  Write-Host "  [5] Toggle auto-start at login"
  Write-Host "  [6] Exit  (bot keeps running)`n"
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
    '6' { exit }
  }
}
