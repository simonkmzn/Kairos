# Tiny zero-dependency local web server.
#   GET  /...                   serves project files
#   POST /api/save?path=...     writes the request body to results/ or config/
#   GET  /api/news              latest crypto headlines from a fixed set of RSS feeds (cached 5 min)
#   GET  /api/fng?limit=N       Crypto Fear & Greed index from alternative.me (cached 10 min)
# Listens on localhost only.
param([int]$Port = 8777)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$writableDirs = @('results', 'config')
$writableExt = @('.json', '.js', '.csv')
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.csv' = 'text/csv; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.txt' = 'text/plain; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
}
$feeds = @(
  @{ source = 'CoinDesk';      url = 'https://www.coindesk.com/arc/outboundfeeds/rss' },
  @{ source = 'Cointelegraph'; url = 'https://cointelegraph.com/rss' },
  @{ source = 'Decrypt';       url = 'https://decrypt.co/feed' },
  @{ source = 'The Block';     url = 'https://www.theblock.co/rss.xml' }
)
$cache = @{ news = $null; newsAt = [DateTime]::MinValue; fng = @{} }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
[Console]::WriteLine("Signal Terminal running at http://localhost:$Port/   (close this window to stop)")

function Send($res, [int]$code, [string]$type, [byte[]]$bytes) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers.Add('Cache-Control', 'no-store')
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function SendText($res, [int]$code, [string]$text) {
  Send $res $code 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($text))
}
function SendJson($res, [string]$json) {
  Send $res 200 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function ParseDate([string]$s) {
  try { return [DateTimeOffset]::Parse($s, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() } catch {}
  try { return [DateTimeOffset]::ParseExact($s.Trim(), 'ddd, dd MMM yyyy HH:mm:ss zzz', [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() } catch {}
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function FetchNews {
  $items = New-Object System.Collections.ArrayList
  foreach ($f in $feeds) {
    try {
      $raw = (Invoke-WebRequest -Uri $f.url -UseBasicParsing -TimeoutSec 6 -Headers @{ 'User-Agent' = 'Mozilla/5.0 SignalTerminal/1.0' }).Content
      [xml]$x = $raw
      $entries = @()
      if ($x.rss -and $x.rss.channel) { $entries = @($x.rss.channel.item) }
      elseif ($x.feed) { $entries = @($x.feed.entry) }
      foreach ($e in $entries | Select-Object -First 25) {
        $title = if ($e.title -is [string]) { $e.title } elseif ($e.title.'#cdata-section') { $e.title.'#cdata-section' } else { [string]$e.title.InnerText }
        $link = if ($e.link -is [string]) { $e.link } elseif ($e.link.href) { $e.link.href } else { [string]$e.link.InnerText }
        $pub = if ($e.pubDate) { $e.pubDate } elseif ($e.published) { $e.published } elseif ($e.updated) { $e.updated } else { '' }
        if (-not $title) { continue }
        [void]$items.Add(@{ source = $f.source; title = [Net.WebUtility]::HtmlDecode(([string]$title).Trim()); link = ([string]$link).Trim(); published = (ParseDate ([string]$pub)) })
      }
    } catch { [Console]::WriteLine("news: $($f.source) failed: $($_.Exception.Message)") }
  }
  $sorted = $items | Sort-Object { $_.published } -Descending | Select-Object -First 60
  return (@{ fetchedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); items = @($sorted) } | ConvertTo-Json -Compress -Depth 4)
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/api/save') {
      $rel = $req.QueryString['path']
      if (-not $rel -or $rel -match '\.\.' -or $rel -match '^[\\/]' -or $rel -match ':') { SendText $res 400 'bad path'; continue }
      $first = ($rel -split '[\\/]')[0]
      $ext = [IO.Path]::GetExtension($rel).ToLowerInvariant()
      if ($writableDirs -notcontains $first -or $writableExt -notcontains $ext) { SendText $res 403 'not writable'; continue }
      $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $full.StartsWith($root)) { SendText $res 403 'outside project'; continue }
      New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
      $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd()
      $reader.Close()
      [IO.File]::WriteAllText($full, $body, (New-Object Text.UTF8Encoding($false)))
      [Console]::WriteLine("saved $rel ($($body.Length) chars)")
      SendText $res 200 'ok'
    }
    elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/api/news') {
      if ($null -eq $cache.news -or ([DateTime]::UtcNow - $cache.newsAt).TotalMinutes -gt 5) {
        $cache.news = FetchNews
        $cache.newsAt = [DateTime]::UtcNow
      }
      SendJson $res $cache.news
    }
    elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/api/fng') {
      $limit = $req.QueryString['limit']
      if (-not ($limit -match '^\d{1,4}$')) { $limit = '30' }
      $hit = $cache.fng[$limit]
      if ($null -eq $hit -or ([DateTime]::UtcNow - $hit.at).TotalMinutes -gt 10) {
        $body = (Invoke-WebRequest -Uri "https://api.alternative.me/fng/?limit=$limit&format=json" -UseBasicParsing -TimeoutSec 8).Content
        $hit = @{ at = [DateTime]::UtcNow; body = $body }
        $cache.fng[$limit] = $hit
      }
      SendJson $res $hit.body
    }
    elseif ($req.HttpMethod -eq 'GET' -or $req.HttpMethod -eq 'HEAD') {
      if ($path -eq '/') { $path = '/index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if (-not $full.StartsWith($root)) { SendText $res 403 'forbidden'; continue }
      if (-not [IO.File]::Exists($full)) { SendText $res 404 'not found'; continue }
      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      Send $res 200 $type ([IO.File]::ReadAllBytes($full))
    }
    else { SendText $res 405 'method not allowed' }
  }
  catch {
    [Console]::WriteLine("error: $($_.Exception.Message)")
    try { SendText $res 500 $_.Exception.Message } catch {}
  }
  finally {
    try { $res.Close() } catch {}
  }
}
