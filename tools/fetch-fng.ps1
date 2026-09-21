# Downloads the full Crypto Fear & Greed Index history (alternative.me, daily since 2018-02)
# into data/fng.json as [[dayMs, value], ...] oldest first.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'data\fng.json'
$r = Invoke-RestMethod -Uri 'https://api.alternative.me/fng/?limit=0&format=json' -TimeoutSec 30
$rows = @()
foreach ($d in $r.data) {
  $ts = ([int64]$d.timestamp) * 1000
  $v = [int]$d.value
  $rows += ,@($ts, $v)
}
$rows = $rows | Sort-Object { $_[0] }
$json = '{"source":"alternative.me","fetchedAt":"' + (Get-Date).ToUniversalTime().ToString('o') + '","values":[' + (($rows | ForEach-Object { "[$($_[0]),$($_[1])]" }) -join ',') + ']}'
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding $false))
Write-Host ("fng.json  {0} days  {1} -> {2}" -f $rows.Count, ([DateTimeOffset]::FromUnixTimeMilliseconds($rows[0][0]).ToString('yyyy-MM-dd')), ([DateTimeOffset]::FromUnixTimeMilliseconds($rows[-1][0]).ToString('yyyy-MM-dd')))
