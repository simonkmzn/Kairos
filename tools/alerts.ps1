# Phone alerts for the trades you would actually take (4H, max 3 open), through ntfy
# (https://ntfy.sh - free app for iPhone / Android, no account). The hourly logger calls
# this after every sweep.
#   alerts.ps1 -Setup   create tools\alerts.json with a private random channel name
#   alerts.ps1 -Test    send a test notification
#   alerts.ps1 -Preview print the alerts for the latest trade and the latest close, send nothing
#   alerts.ps1          send every alert not sent yet: TAKE IT when the capped book opens a
#                       trade, and a message when one closes (CLOSE NOW for the time-out)
# tools\alerts.json and tools\alerts-sent.json stay on this PC (.gitignore): anyone who
# knows the channel name could read the alerts.
param([switch]$Setup, [switch]$Test, [switch]$Preview)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cfgFile = Join-Path $root 'tools\alerts.json'
$sentFile = Join-Path $root 'tools\alerts-sent.json'
$fwFile = Join-Path $root 'results\forward.json'
$logFile = Join-Path $root 'results\logger.log'
$utf8 = New-Object Text.UTF8Encoding $false
$inv = [Globalization.CultureInfo]::InvariantCulture

function Log($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

if ($Setup) {
  if (Test-Path $cfgFile) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json; Write-Host "Already set up. Channel: $($cfg.topic)"; exit 0 }
  $chars = 'abcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $topic = 'signal-terminal-' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
  $cfg = [ordered]@{ server = 'https://ntfy.sh'; topic = $topic; site = 'https://simonkmzn.github.io/Kairos/'; maxEntryAgeHours = 8; maxExitAgeHours = 24 }
  [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json), $utf8)
  Write-Host "Channel: $topic"
  exit 0
}

if (-not (Test-Path $cfgFile)) { exit 0 }   # alerts not set up: nothing to do
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json

function Send($title, $message, [int]$priority, $tags, $click) {
  $body = [ordered]@{ topic = $cfg.topic; title = $title; message = $message; priority = $priority; tags = @($tags) }
  if ($click) { $body.click = $click }
  $json = $body | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $cfg.server -Method Post -Body $utf8.GetBytes($json) -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 | Out-Null
}

if ($Test) {
  Send 'Signal Terminal: test' "Alerts are working. You'll get TAKE IT here when the 4H max-3 record opens a trade, and a message when one closes." 3 @('white_check_mark') $cfg.site
  Write-Host 'Test alert sent.'
  exit 0
}

# ---------- read the capped book (forward.json can outgrow ConvertFrom-Json's 2 MB limit) ----------
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$fw = $ser.DeserializeObject([IO.File]::ReadAllText($fwFile))
$book = $null
if ($fw.ContainsKey('book') -and $fw['book'] -and $fw['book'].ContainsKey('4h')) { $book = $fw['book']['4h'] }
if (-not $book) { exit 0 }
$trades = @($book['trades'])
$barMs = 4 * 3600000
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function When([long]$ms) { [DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime.ToString('ddd MMM d, HH:mm', $inv) }
function Px($v) {
  $v = [double]$v; $a = [math]::Abs($v)
  $d = if ($a -ge 100) { 2 } elseif ($a -ge 1) { 3 } elseif ($a -ge 0.1) { 4 } elseif ($a -ge 0.001) { 6 } else { 8 }
  $v.ToString("N$d", $inv)
}
function Pct($v) { $s = ([double]$v * 100).ToString('0.0', $inv); if ([double]$v -gt 0) { "+$s%" } else { "$s%" } }
function Coin($t) { "$($t['symbol'])".Replace('USDT', '') }
function SideOf($t) { if ([int]$t['side'] -gt 0) { 'LONG' } else { 'SHORT' } }
function Has($t, $k) { $t.ContainsKey($k) -and $null -ne $t[$k] }

# ---------- what was already sent ----------
$sent = @{ entries = @(); exits = @() }
$first = -not (Test-Path $sentFile)
if (-not $first) { $s = Get-Content $sentFile -Raw | ConvertFrom-Json; $sent.entries = @($s.entries); $sent.exits = @($s.exits) }
$entrySet = New-Object 'System.Collections.Generic.HashSet[string]'; foreach ($x in $sent.entries) { [void]$entrySet.Add($x) }
$exitSet = New-Object 'System.Collections.Generic.HashSet[string]'; foreach ($x in $sent.exits) { [void]$exitSet.Add($x) }

function EntryAlert($t) {
  $closeMs = [long]$t['t'] + $barMs   # the candle close the trade was entered at
  $ageH = ($nowMs - $closeMs) / 3600000
  $entry = [double]$t['entry']; $sl = [double]$t['slDist']; $side = [int]$t['side']; $id = "$($t['id'])"
  $lines = @("Entry ~$(Px $entry) (4H candle closed $(When $closeMs))")
  if ($ageH -gt 1.5) { $lines += "Signal is $([math]::Round($ageH, 1)) hours old - check the price is still near the entry." }
  $lines += "Stop $(Px ($entry - $side * $sl)) ($(Pct (-$side * $sl / $entry)))"
  if (Has $t 'target') { $tgt = [double]$t['target']; $lines += "Target $(Px $tgt) ($(Pct ($side * ($tgt - $entry) / $entry)))" } else { $lines += 'No fixed target: trailing stop' }
  $risk = 0.02; if (Has $t 'risk') { $risk = [double]$t['risk'] }
  $lines += "Risk $([math]::Round($risk * 100, 1))% of account = position about $([math]::Round($risk / ($sl / $entry) * 100))% of account"
  if ($t['be']) { $lines += "Move the stop to $(Px $entry) once price reaches $(Px ($entry + $side * $sl))" }
  if ("$($t['stopMode'])" -eq 'trail') { $lines += 'Trailing stop: keep it one stop-distance behind the best price' }
  $lines += "Time-out: close at market if still open on $(When ([long]$t['t'] + ([long]$t['maxBars'] + 1) * $barMs))"
  $others = @($trades | Where-Object { "$($_['id'])" -ne $id -and "$($_['status'])" -eq 'open' -and [long]$_['t'] -le [long]$t['t'] } | ForEach-Object { "$(Coin $_) $((SideOf $_).ToLower())" })
  $slot = if (Has $t 'slot') { [int]$t['slot'] } else { $others.Count + 1 }
  $lines += "Slot $slot of $($book['cap'])$(if ($others.Count) { ': also ' + ($others -join ', ') } else { '' })"
  @{ title = "TAKE IT: $(Coin $t) $(SideOf $t) (4H)"; message = ($lines -join "`n"); priority = 4; tag = $(if ($side -gt 0) { 'chart_with_upwards_trend' } else { 'chart_with_downwards_trend' }); click = "$($cfg.site)#$(Coin $t)/4h"; ageH = $ageH }
}
function ExitAlert($t) {
  $kind = [int]$t['kind']
  $r = [double]$t['R']; $rs = $r.ToString('+0.00;-0.00', $inv) + 'R'
  $name = "$(Coin $t) $((SideOf $t).ToLower())"
  $a = switch ($kind) {
    0 { @{ title = "CLOSE NOW: $name time-out ($rs)"; message = "5 days are up: close this position at market now. Result so far $rs. The slot is free again."; priority = 4; tag = 'alarm_clock'; click = "$($cfg.site)#$(Coin $t)/4h" } }
    1 { @{ title = "TARGET HIT: $name $rs"; message = "Price reached the take-profit at $(Px $t['target']). If your target order was in, it filled. The slot is free again."; priority = 3; tag = 'white_check_mark'; click = $null } }
    2 { @{ title = "TRAILING STOP HIT: $name $rs"; message = 'Price came back to the trailing stop. Closed in profit. The slot is free again.'; priority = 3; tag = 'white_check_mark'; click = $null } }
    default { @{ title = "STOPPED OUT: $name $rs"; message = "Price hit the stop at $(Px ([double]$t['entry'] - [int]$t['side'] * [double]$t['slDist'])). A normal loss: the formula is right about 45% of the time and makes its money on the bigger winners. The slot is free again."; priority = 3; tag = 'x'; click = $null } }
  }
  $a.ageH = ($nowMs - ([long]$t['exitT'] + $(if ($kind -eq 0) { $barMs } else { 0 }))) / 3600000
  $a
}

if ($Preview) {
  $last = $trades | Sort-Object { [long]$_['t'] } | Select-Object -Last 1
  $closed = $trades | Where-Object { "$($_['status'])" -eq 'closed' } | Sort-Object { [long]$_['exitT'] } | Select-Object -Last 1
  foreach ($a in @((EntryAlert $last), (ExitAlert $closed))) { Write-Host "---- $($a.title)  [priority $($a.priority), $($a.tag)]"; Write-Host $a.message; Write-Host "(tap opens: $($a.click))`n" }
  exit 0
}

$count = 0
foreach ($t in $trades) {
  $id = "$($t['id'])"
  if (-not $entrySet.Contains($id)) {
    [void]$entrySet.Add($id)
    $a = EntryAlert $t
    if (-not $first -and $a.ageH -le $cfg.maxEntryAgeHours) {
      try { Send $a.title $a.message $a.priority @($a.tag) $a.click; Log "alert sent: TAKE IT $(Coin $t) $((SideOf $t).ToLower())"; $count++ }
      catch { [void]$entrySet.Remove($id); Log "alert failed (will retry): $($_.Exception.Message)" }
    }
  }
  if ("$($t['status'])" -eq 'closed' -and -not $exitSet.Contains($id)) {
    [void]$exitSet.Add($id)
    $a = ExitAlert $t
    if (-not $first -and $a.ageH -le $cfg.maxExitAgeHours) {
      try { Send $a.title $a.message $a.priority @($a.tag) $a.click; Log "alert sent: $($a.title)"; $count++ }
      catch { [void]$exitSet.Remove($id); Log "alert failed (will retry): $($_.Exception.Message)" }
    }
  }
}

$out = [ordered]@{ updatedAt = $nowMs; entries = @($entrySet); exits = @($exitSet) }
[IO.File]::WriteAllText($sentFile, ($out | ConvertTo-Json -Compress), $utf8)
if ($first) { Log "alerts armed: $($entrySet.Count) existing trades marked as already sent" }
