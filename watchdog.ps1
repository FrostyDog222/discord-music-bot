# Runs on a schedule (login + every 5 minutes) and from the dashboard's Start.
# Starts the bot if it isn't running - unless the user stopped it on purpose (.stopped flag).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
Set-Location -LiteralPath $PSScriptRoot

# Only one launcher at a time, so two can't both start a bot (and truncate each other's logs).
$mutex = New-Object Threading.Mutex($false, 'Local\DiscordMusicBotLauncher')
if (-not $mutex.WaitOne(0)) { return }
try {
  $flag = Join-Path $PSScriptRoot '.stopped'
  # A deliberate Stop lasts until the next reboot, not forever. LastBootUpTime alone misses a
  # Shut down + power-on with Fast Startup, so use the latest cold (0) / fast (1) boot event.
  if (Test-Path -LiteralPath $flag) {
    $boot = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Boot'; Id = 27 } `
      -MaxEvents 20 -ErrorAction SilentlyContinue | Where-Object { $_.Properties[0].Value -le 1 } |
      Select-Object -First 1 -ExpandProperty TimeCreated
    if (-not $boot) { $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime }
    if ((Get-Item -LiteralPath $flag).LastWriteTime -lt $boot) { Remove-Item -LiteralPath $flag -Force }
    else { return }
  }

  # Is the bot already running? Match this folder's bot.js (absolute path), or a bare
  # "node bot.js" started from here - never unrelated processes like robot.js.
  $botJs = Join-Path $PSScriptRoot 'bot.js'
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $c = $_.CommandLine  # paths are case-insensitive on Windows
    $c -and ($c.IndexOf($botJs, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $c -match '\s"?bot\.js"?\s*$')
  }
  if ($running) { return }

  # Keep the previous run's logs, so a crash's reason survives the restart.
  foreach ($f in 'bot.log', 'bot.err') {
    if ((Get-Item -LiteralPath $f -ErrorAction SilentlyContinue).Length) { Move-Item -LiteralPath $f "$f.prev" -Force }
  }
  # Trim the restart log so it can't grow forever.
  if ((Get-Item -LiteralPath 'watchdog.log' -ErrorAction SilentlyContinue).Length -gt 200KB) {
    (Get-Content -LiteralPath 'watchdog.log' -Tail 500) | Set-Content -LiteralPath 'watchdog.log' -Encoding ASCII
  }
  Add-Content -LiteralPath 'watchdog.log' "$(Get-Date -Format s) bot was not running - starting it" -Encoding ASCII

  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine')
  Start-Process node -ArgumentList ('"' + $botJs + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput 'bot.log' -RedirectStandardError 'bot.err'
} finally {
  $mutex.ReleaseMutex()
}
