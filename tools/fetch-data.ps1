# Downloads Binance history for Kairos research.
#   -Interval 1h|4h|1d   spot candles (closed only)  -> data/<interval>/<SYMBOL>.json
#   -Funding             USDT-perp funding rates      -> data/funding/<SYMBOL>.json
# Re-running appends only the new rows to existing files.
param(
  [string]$Interval = '1d',
  [string]$Since = '2019-01-01',
  [switch]$Funding,
  [string[]]$Symbols = @('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sub = if ($Funding) { 'funding' } else { $Interval }
$dir = Join-Path $root "data\$sub"
New-Item -ItemType Directory -Force $dir | Out-Null

$sinceMs = [DateTimeOffset]::new([DateTime]::SpecifyKind([DateTime]::Parse($Since), 'Utc')).ToUnixTimeMilliseconds()
$stepMs = @{ '15m' = 900000; '1h' = 3600000; '4h' = 14400000; '1d' = 86400000 }[$Interval]
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Get-Json([string]$path) {
  $hosts = if ($Funding) { @('https://fapi.binance.com') } else { @('https://data-api.binance.vision', 'https://api.binance.com') }
  $err = ''
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    foreach ($h in $hosts) {
      try { return , (Invoke-RestMethod -Uri "$h$path" -TimeoutSec 30) } catch { $err = $_.Exception.Message }
    }
    Start-Sleep -Seconds (2 * ($attempt + 1))
  }
  throw "Request failed: $path ($err)"
}

# "76568.73000000" -> "76568.73"
function Num([string]$s) {
  if ($s.Contains('.')) { $s = $s.TrimEnd('0').TrimEnd('.') }
  if ($s -eq '' -or $s -eq '-') { '0' } else { $s }
}

foreach ($sym in $Symbols) {
  $file = Join-Path $dir "$sym.json"
  $start = $sinceMs
  $existing = $null
  if (Test-Path $file) {
    $existing = [IO.File]::ReadAllText($file)
    $m = [regex]::Match($existing, '\[(\d{13}),[^\[\]]*\]\]\}\s*$')
    if ($m.Success) { $start = [long]$m.Groups[1].Value + $(if ($Funding) { 1 } else { $stepMs }) } else { $existing = $null }
  }

  $rows = New-Object System.Collections.Generic.List[string]
  while ($true) {
    if ($Funding) {
      $batch = Get-Json "/fapi/v1/fundingRate?symbol=$sym&startTime=$start&limit=1000"
      if ($null -eq $batch) { break }
      if ($batch -isnot [System.Array]) { $batch = @($batch) }   # single-record response
      if ($batch.Count -eq 0) { break }
      foreach ($f in $batch) { $rows.Add("[$([long]$f.fundingTime),$(Num ([string]$f.fundingRate))]") }
      $count = $batch.Count
      $start = [long]$batch[$count - 1].fundingTime + 1
    }
    else {
      $batch = Get-Json "/api/v3/klines?symbol=$sym&interval=$Interval&startTime=$start&limit=1000"
      if ($null -eq $batch -or $batch.Count -eq 0) { break }
      if (-not ($batch[0] -is [System.Array])) { $batch = @(, $batch) }   # single-row response
      foreach ($k in $batch) {
        if ([long]$k[6] -ge $nowMs) { continue }   # still forming
        $rows.Add("[$([long]$k[0]),$(Num $k[1]),$(Num $k[2]),$(Num $k[3]),$(Num $k[4]),$(Num $k[5])]")
      }
      $count = $batch.Count
      $start = [long]$batch[$count - 1][0] + $stepMs
    }
    if ($count -lt 1000) { break }
    Start-Sleep -Milliseconds 120
  }

  if ($rows.Count -eq 0) { Write-Output ("{0,-9} {1,-7} up to date" -f $sym, $sub); continue }
  $body = $rows -join ','
  if ($existing) {
    $text = $existing.TrimEnd()
    $text = $text.Substring(0, $text.Length - 2) + ',' + $body + ']}'
  }
  else {
    $key = if ($Funding) { 'rates' } else { 'candles' }
    $text = "{`"symbol`":`"$sym`",`"interval`":`"$sub`",`"$key`":[" + $body + ']}'
  }
  [IO.File]::WriteAllText($file, $text)
  Write-Output ("{0,-9} {1,-7} +{2} rows" -f $sym, $sub, $rows.Count)
}
