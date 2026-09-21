# Unattended forward-test logger.
#   logger.ps1            run one sweep: make sure the local server is up, open the terminal in a
#                         hidden (headless) Edge/Chrome, wait until the page reports the sweep is
#                         saved, close the browser. Appends to results\logger.log.
#   logger.ps1 -Install   register a Windows scheduled task that runs this every hour at :05
#   logger.ps1 -Uninstall remove that task
param([switch]$Install, [switch]$Uninstall, [int]$Port = 8777, [int]$TimeoutSec = 300)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$taskName = 'Signal Terminal logger'
$logFile = Join-Path $root 'results\logger.log'
$statusFile = Join-Path $root 'results\logger-status.json'
New-Item -ItemType Directory -Force (Join-Path $root 'results') | Out-Null

function Log($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Log "Removed scheduled task '$taskName'"
  exit 0
}
if ($Install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`"" -WorkingDirectory $root
  $start = (Get-Date).Date.AddHours((Get-Date).Hour + 1).AddMinutes(5)
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Log "Installed scheduled task '$taskName': every hour at :05 while you are logged in (first run $($start.ToString('HH:mm')))"
  exit 0
}

function ServerUp {
  try { $r = Invoke-WebRequest -Uri "http://localhost:$Port/config/signal.js" -UseBasicParsing -TimeoutSec 4; return ($r.StatusCode -eq 200) } catch { return $false }
}

if (-not (ServerUp)) {
  Log 'server not running; starting it hidden'
  Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\tools\serve.ps1`" -Port $Port" -WindowStyle Hidden
  for ($i = 0; $i -lt 20 -and -not (ServerUp); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (ServerUp)) { Log 'could not start the server'; exit 1 }
}

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { Log 'no Edge or Chrome found'; exit 1 }

$before = if (Test-Path $statusFile) { (Get-Item $statusFile).LastWriteTimeUtc } else { [DateTime]::MinValue }
$profileDir = Join-Path $env:TEMP 'signal-terminal-logger'
$browserArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', "--user-data-dir=`"$profileDir`"", "`"http://localhost:$Port/index.html?logger=1`"")
$p = Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru -WindowStyle Hidden
Log "launched $(Split-Path $exe -Leaf) (pid $($p.Id)) for a sweep"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if ((Test-Path $statusFile) -and ((Get-Item $statusFile).LastWriteTimeUtc -gt $before)) { $done = $true; break }
  if ($p.HasExited) { break }
}
# Headless browsers spawn helper processes; close every process using our private profile folder.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like '*signal-terminal-logger*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Rolling machine-readable history of runs, so the terminal (and the phone) can show
# the logger at work without reading the text log.
function RecordRun($ok, $note, $s) {
  $runsFile = Join-Path $root 'results\logger-runs.json'
  $runs = @()
  if (Test-Path $runsFile) {
    try { $runs = @((Get-Content $runsFile -Raw | ConvertFrom-Json).runs) } catch { $runs = @() }
  }
  $entry = [ordered]@{
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    ok = [bool]$ok
    note = "$note"
    trades = $(if ($s) { [int]$s.trades } else { $null })
    open = $(if ($s) { [int]$s.open } else { $null })
    closed = $(if ($s) { [int]$s.closed } else { $null })
  }
  $runs = @($runs | Where-Object { $_ -ne $null }) + $entry
  if ($runs.Count -gt 60) { $runs = $runs[($runs.Count - 60)..($runs.Count - 1)] }
  $json = @{ updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); runs = $runs } | ConvertTo-Json -Depth 4 -Compress
  [IO.File]::WriteAllText($runsFile, $json, (New-Object Text.UTF8Encoding $false))
}

# If this folder has been published to GitHub, push the updated log so the phone sees it.
# Finds git on PATH or inside GitHub Desktop. Silently does nothing until the repo exists.
function PushToGitHub {
  if (-not (Test-Path (Join-Path $root '.git'))) { return }
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if (-not $git) {
    $git = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\cmd\git.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $git) { return }
  Push-Location $root
  try {
    & $git add results/forward.json results/logger-runs.json results/logger-status.json 2>&1 | Out-Null
    $staged = & $git diff --cached --name-only 2>&1
    if (-not $staged) { return }
    & $git -c user.name='Signal Terminal logger' -c user.email='logger@localhost' commit -m "forward test: sweep $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
    $out = & $git push 2>&1
    if ($LASTEXITCODE -eq 0) { Log 'pushed the log to GitHub' } else { Log "git push failed: $out" }
  } catch {
    Log "git push error: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

if ($done) {
  $s = $null
  try { $s = Get-Content $statusFile -Raw | ConvertFrom-Json } catch {}
  if ($s) {
    Log ("sweep saved: {0} trades logged ({1} open, {2} closed){3}" -f $s.trades, $s.open, $s.closed, $(if ($s.error) { ", last problem: $($s.error)" } else { '' }))
  } else { Log 'sweep saved' }
  RecordRun $true 'sweep saved' $s
  PushToGitHub
  exit 0
}
Log 'sweep did not report back in time (browser closed)'
RecordRun $false 'browser closed before the sweep reported' $null
exit 1
