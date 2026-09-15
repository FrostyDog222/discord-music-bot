# Runs on a schedule (login + every few minutes). Starts the bot if it isn't
# running — UNLESS the user stopped it on purpose (.stopped flag from the dashboard).
Set-Location $PSScriptRoot
if (Test-Path (Join-Path $PSScriptRoot '.stopped')) { return }   # deliberately stopped
if (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bot.js*' }) { return } # already running
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'Machine')
Start-Process node -ArgumentList 'bot.js' -WindowStyle Hidden `
  -RedirectStandardOutput 'bot.log' -RedirectStandardError 'bot.err'
