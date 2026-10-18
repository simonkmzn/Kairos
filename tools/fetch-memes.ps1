# Downloads Binance history for the meme-coin section: 1h / 4h / 1d spot candles and
# USDT-perp funding rates. Several meme perps trade in units of 1000 (1000PEPEUSDT); their
# funding is saved under the spot name (data/funding/PEPEUSDT.json) so the engine finds it.
# Re-running appends only the new rows.
param([string[]]$Intervals = @('1h', '4h', '1d'))

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
# spot symbol -> perpetual symbol
$memes = [ordered]@{
  DOGEUSDT = 'DOGEUSDT'; SHIBUSDT = '1000SHIBUSDT'; PEPEUSDT = '1000PEPEUSDT'; FLOKIUSDT = '1000FLOKIUSDT'
  BONKUSDT = '1000BONKUSDT'; WIFUSDT = 'WIFUSDT'; BOMEUSDT = 'BOMEUSDT'; PEOPLEUSDT = 'PEOPLEUSDT'
  NEIROUSDT = 'NEIROUSDT'; PNUTUSDT = 'PNUTUSDT'; TRUMPUSDT = 'TRUMPUSDT'; PENGUUSDT = 'PENGUUSDT'
}
$spot = @($memes.Keys)

foreach ($iv in $Intervals) { & (Join-Path $here 'fetch-data.ps1') -Interval $iv -Symbols $spot }
# BTC drives the "what is Bitcoin doing" inputs; keep its candles current too.
foreach ($iv in $Intervals) { & (Join-Path $here 'fetch-data.ps1') -Interval $iv -Symbols @('BTCUSDT') }

# Funding: fetch under the perp name, store under the spot name.
$fundDir = Join-Path $root 'data\funding'
foreach ($s in $spot) {
  $perp = $memes[$s]
  if ($perp -eq $s) { & (Join-Path $here 'fetch-data.ps1') -Funding -Symbols @($s); continue }
  $tmp = Join-Path $fundDir "$perp.json"
  $dst = Join-Path $fundDir "$s.json"
  if ((Test-Path $dst) -and -not (Test-Path $tmp)) { Copy-Item $dst $tmp }   # resume from what we have
  & (Join-Path $here 'fetch-data.ps1') -Funding -Symbols @($perp)
  if (Test-Path $tmp) { Move-Item $tmp $dst -Force }
}
