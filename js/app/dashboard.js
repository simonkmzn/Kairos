(function () {
  'use strict';
  const K = window.KAIROS;
  const Dt = K.data, Eng = K.signalEngine, Sg = K.signal, News = K.news;
  const $ = (s) => document.querySelector(s);
  const COINS = Dt.COINS;
  const MINUS = '−';
  const TFS = [
    { id: '5m', label: '5M', tv: '5', sig: '1h' },
    { id: '15m', label: '15M', tv: '15', sig: '1h' },
    { id: '1h', label: '1H', tv: '60', sig: '1h' },
    { id: '4h', label: '4H', tv: '240', sig: '4h' },
    { id: '1d', label: '1D', tv: 'D', sig: '1d' },
    { id: '1w', label: '1W', tv: 'W', sig: '1d' },
    { id: '1M', label: '1M', tv: 'M', sig: '1d' },
  ];
  const SIG_LABEL = { '1h': '1H', '4h': '4H', '1d': '1D' };
  const REFRESH_MS = 60000;
  const state = { coin: 'BTCUSDT', tf: '4h', tickers: {}, analysis: null, derived: null, news: null, newsError: null, tvKey: '', live: false, run: 0, params: {} };

  // ---------------- formatting ----------------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtPrice(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v), d = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : 5;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const usd = (v) => (Number.isFinite(v) ? '$' + fmtPrice(v) : '—');
  const pct = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%' : '—');
  const pctAbs = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
  const signed = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v).toFixed(d) : '—');
  const compact = (v) => (v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v).toLocaleString('en-US'));
  const coinOf = (s) => COINS.find((c) => c.symbol === s);
  const tfOf = (id) => TFS.find((t) => t.id === id) || TFS[3];
  const sigTf = () => tfOf(state.tf).sig;
  const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false });
  const monthYear = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const barTime = (t, tf) => new Date(t).toLocaleString('en-US', tf === '1d' ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const ago = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  const horizonText = (tf, bars) => {
    const h = (K.features.TIMEFRAMES[tf].barMs * bars) / 3600000;
    return h < 24 || h % 24 ? `${h}h` : `${h / 24}d`;
  };
  const comboLabel = Sg.comboLabel;
  const fmtTheta = (th) => (th[0] === th[1] ? `±${th[0]}` : `+${th[0]} / ${MINUS}${th[1]}`);
  const NO_EDGE_TF = { '1h': 'use 4H or 1D', '4h': 'use 1D', '1d': 'use 4H' };

  // ---------------- URL + parameter state ----------------
  function parseHash() {
    const parts = decodeURIComponent(location.hash.slice(1)).split('/');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('terminal.view') || '{}'); } catch (e) { /* blocked */ }
    const tk = (parts[0] || saved.ticker || 'BTC').toUpperCase();
    state.coin = (COINS.find((c) => c.ticker === tk) || COINS[0]).symbol;
    const tf = parts[1] || saved.tf;
    state.tf = TFS.some((t) => t.id === tf) ? tf : '4h';
  }
  function writeHash() {
    const c = coinOf(state.coin);
    const h = `#${c.ticker}/${state.tf}`;
    if (location.hash !== h) history.replaceState(null, '', h);
    try { localStorage.setItem('terminal.view', JSON.stringify({ ticker: c.ticker, tf: state.tf })); } catch (e) { /* blocked */ }
  }
  function loadParams() {
    try { state.params = JSON.parse(localStorage.getItem('terminal.params') || '{}'); } catch (e) { state.params = {}; }
  }
  const paramsFor = (tf) => state.params[tf] || {};
  function setParams(tf, patch) {
    state.params[tf] = Object.assign({}, paramsFor(tf), patch);
    if (patch === null) delete state.params[tf];
    try { localStorage.setItem('terminal.params', JSON.stringify(state.params)); } catch (e) { /* blocked */ }
  }

  // ---------------- controls ----------------
  function renderControls() {
    $('#coin').innerHTML = COINS.map((c) => `<option value="${c.symbol}" ${c.symbol === state.coin ? 'selected' : ''}>${c.ticker} / USD</option>`).join('');
    $('#tfs').innerHTML = TFS.map((t) => `<button type="button" role="radio" aria-checked="${t.id === state.tf}" data-tf="${t.id}">${t.label}</button>`).join('');
  }

  // ---------------- TradingView ----------------
  function mountTv() {
    const box = $('#tv'), k = state.coin + state.tf;
    if (!window.TradingView) {
      if (!box.firstChild) box.innerHTML = '<div class="tv-fallback">Loading TradingView chart…</div>';
      return;
    }
    if (state.tvKey === k) return;
    state.tvKey = k;
    box.innerHTML = '<div id="tv-widget" style="height:100%;width:100%"></div>';
    let tz = 'Etc/UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* keep UTC */ }
    new window.TradingView.widget({
      container_id: 'tv-widget', autosize: true,
      symbol: 'BINANCE:' + state.coin, interval: tfOf(state.tf).tv, timezone: tz,
      theme: 'dark', style: '1', locale: 'en',
      toolbar_bg: '#17181a', backgroundColor: '#131416', gridColor: 'rgba(255,255,255,0.04)',
      enable_publishing: false, allow_symbol_change: false, hide_side_toolbar: false, withdateranges: true, save_image: false,
    });
  }
  window.__tvReady = () => { state.tvKey = ''; mountTv(); };
  setTimeout(() => {
    if (!window.TradingView && $('#tv .tv-fallback')) $('#tv').innerHTML = '<div class="tv-fallback">The TradingView chart could not load (internet or ad blocker). The signal panel still works.</div>';
  }, 12000);

  // ---------------- stats strip ----------------
  function renderStats() {
    const t = state.tickers[state.coin], a = state.analysis;
    const mine = a && a.symbol === state.coin;
    const cell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('#stats').innerHTML =
      cell('24h high', t ? usd(t.high) : '—') +
      cell('24h low', t ? usd(t.low) : '—') +
      cell('24h volume', t ? compact(t.quoteVolume) : '—') +
      cell(`ATR (14) · ${SIG_LABEL[sigTf()]}`, mine ? fmtPrice(a.atr) : '—') +
      cell('Support', mine && Number.isFinite(a.support) ? usd(a.support) : '—') +
      cell('Resistance', mine && Number.isFinite(a.resistance) ? usd(a.resistance) : '—');
  }

  // ---------------- news ----------------
  function newsTilt() {
    const bias = News.getBias(state.coin), pm = paramsFor(sigTf());
    const cap = Number.isFinite(pm.cap) ? pm.cap : News.HEADLINE_CAP;
    const raw = state.news ? News.score(state.news.items, state.coin).tilt : 0;
    const head = (raw / News.HEADLINE_CAP) * cap;
    return { head, bias: bias.value || 0, note: bias.note || '', total: head + (bias.value || 0) };
  }

  function renderNews() {
    const c = coinOf(state.coin), bias = News.getBias(state.coin);
    const ns = state.news ? News.score(state.news.items, state.coin) : null;
    const scored = ns ? ns.scored : null;
    const a = state.analysis && state.analysis.symbol === state.coin ? state.analysis : null;
    const tilt = newsTilt();
    $('#news-meta').innerHTML = `news tilt <b class="${tilt.total > 0 ? 'g' : tilt.total < 0 ? 'r' : ''}">${signed(tilt.total, 2)}</b> <span class="untested">untested</span>`;
    const events = a ? `<div class="events">
        <span title="Crypto Fear & Greed index, 0 = extreme fear, 100 = extreme greed (tested input)">Fear &amp; Greed <b>${Number.isFinite(a.fng) ? Math.round(a.fng) : '—'}</b> <i>${Number.isFinite(a.fng) ? (a.fng >= 75 ? 'extreme greed' : a.fng >= 55 ? 'greed' : a.fng > 45 ? 'neutral' : a.fng > 25 ? 'fear' : 'extreme fear') : ''}${a.fngSource === 'file' ? ' · offline copy' : ''}</i></span>
        <span title="Next FOMC rate decision (tested input, ramps over the 48h before)">Fed decision <b>${Number.isFinite(a.fomcHours) ? (a.fomcHours < 48 ? 'in ' + Math.round(a.fomcHours) + 'h' : 'in ' + Math.round(a.fomcHours / 24) + 'd') : '—'}</b></span>
        <span>Headlines <b class="${tilt.head > 0 ? 'g' : tilt.head < 0 ? 'r' : ''}">${signed(tilt.head, 2)}</b> <i>${ns ? `${ns.bullish} bullish · ${ns.bearish} bearish` : 'no feed'}</i></span>
      </div>` : '';
    const controls = `<div class="bias">
        <label for="ev-bias">Your event bias for ${c.ticker}</label>
        <select id="ev-bias">${News.BIAS_LEVELS.map((l) => `<option value="${l.value}" ${l.value === (bias.value || 0) ? 'selected' : ''}>${l.label}${l.value ? ` (${signed(l.value, 2)})` : ''}</option>`).join('')}</select>
        <input id="ev-note" type="text" maxlength="80" placeholder="why? e.g. GTA6 launch, ETF decision" value="${esc(bias.note || '')}">
      </div>`;
    let list;
    if (state.newsError) list = `<p class="empty">Live headlines need <code>serve.cmd</code> running (${esc(state.newsError)}). Your event bias still applies.</p>`;
    else if (!scored) list = '<div class="skel" style="height:120px"></div>';
    else list = `<ul class="news-list">${scored.slice(0, 12).map((it) => `<li class="${it.relevance === 1 ? 'mine' : ''}">
        <span class="tag ${it.sent > 0 ? 'bull' : it.sent < 0 ? 'bear' : 'flat'}">${it.sent > 0 ? '▲' : it.sent < 0 ? '▼' : '–'}</span>
        <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="src">${esc(it.source)} · ${ago(it.ageH)}${it.relevance === 1 ? ` · ${c.ticker}` : ''}</span></li>`).join('')}</ul>`;
    $('#news').innerHTML = events + controls + list;
  }

  async function loadNews() {
    try {
      state.news = await News.fetchNews();
      state.newsError = null;
    } catch (err) {
      state.news = null;
      state.newsError = err.name === 'AbortError' ? 'timed out' : err.message;
    }
    renderNews();
    rerender();
  }

  // ---------------- forward test ----------------
  const Fw = K.forward;
  function renderForward() {
    const st = Fw.state;
    const C = window.SIGNAL_CONFIG;
    if (!st.loaded) { $('#forward').innerHTML = '<div class="skel" style="height:90px"></div>'; return; }
    const meta = [];
    if (st.sweeping) meta.push('<span class="updating">sweeping…</span>');
    else if (st.lastSweepAt) meta.push(`swept ${clock(st.lastSweepAt)}`);
    meta.push(`since ${new Date(st.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
    meta.push(st.server ? 'results/forward.json' : 'this browser only');
    if (st.logger && st.logger.at) meta.push(`auto-logger ran ${barTime(st.logger.at, '1h')}`);
    $('#fw-meta').innerHTML = meta.join(' · ');
    const tiles = Fw.TFS.map((tf) => {
      const cfg = C && C.timeframes && C.timeframes[tf];
      const trades = st.trades.filter((t) => t.tf === tf), s = Fw.stats(trades);
      const bt = cfg && cfg.holdoutRecent;
      const gated = cfg && cfg.config.edge === 'none';
      return `<div class="fw-tf"><div class="k"><span>${SIG_LABEL[tf]}${gated ? ' · gated' : ''}</span><span>${s.closed} closed · ${s.open} open</span></div>
        <div class="v ${s.closed ? (s.avgR > 0 ? 'g' : 'r') : 'muted'}">${s.closed ? signed(s.avgR, 3) + 'R' : '—'}<small class="muted" style="font-size:11px;font-weight:500"> per trade</small></div>
        <div class="s">${s.closed ? `win ${pctAbs(s.winRate, 0)} · total ${signed(s.totalR, 1)}R · @1% ${pct(s.return1pct, 1)}` : 'no closed trades yet'}${s.open ? ` · open ${signed(s.unrealizedR, 2)}R` : ''}<br>backtest since ${bt ? monthYear(cfg.windows.recentStart) : '—'}: ${bt && bt.trades ? `${signed(bt.avgR, 3)}R, win ${pctAbs(bt.winRate, 0)}, ${bt.trades} trades` : '—'}</div></div>`;
    }).join('');
    const recent = st.trades.slice().sort((x, y) => y.t - x.t).slice(0, 14);
    const list = recent.length ? `<ul class="fw-list">${recent.map((t) => {
      const cb = C.timeframes[t.tf] && C.timeframes[t.tf].config.combos[t.combo];
      const res = t.status === 'closed'
        ? `<b class="${t.R > 0 ? 'g' : 'r'}">${signed(t.R, 2)}R</b><small>${t.kind === 1 ? 'target' : t.kind === -1 ? 'stop' : t.kind === 2 ? 'trailed' : 'time-out'} · ${t.bars} bars</small>`
        : `<b class="${(t.unrealized || 0) >= 0 ? 'g' : 'r'}">${signed(t.unrealized || 0, 2)}R</b><small>open${t.stale ? ' · stale' : ''} · ${t.bars || 0} bars</small>`;
      return `<li><span class="tag ${t.side > 0 ? 'bull' : 'bear'}">${t.side > 0 ? '▲' : '▼'}</span><span class="when">${barTime(t.t + K.features.TIMEFRAMES[t.tf].barMs, t.tf)}</span><b>${t.symbol.replace('USDT', '')}</b><span class="lv">${SIG_LABEL[t.tf]} ${t.side > 0 ? 'long' : 'short'} @ ${fmtPrice(t.entry)} · stop ${fmtPrice(t.stop)} · ${t.target !== null ? 'target ' + fmtPrice(t.target) : 'trailing'} · p ${pctAbs(t.p, 0)} · risk ${pctAbs(t.risk, 1)}${cb ? '' : ' · older engine'}</span><span class="res">${res}</span></li>`;
    }).join('')}</ul>` : `<p class="empty" style="padding:8px 0">No calls logged yet. Every call the tested formula makes at a candle close after ${new Date(Date.parse(C.generatedAt)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (the last tuning) will appear here and be scored against what the market did next. Keep this page open, or open it now and then — it catches up on the last 300 candles.</p>`;
    $('#forward').innerHTML = tiles.replace(/^/, '<div class="fw-grid">') + '</div>' + list + (st.error ? `<p class="note r">Last sweep problem: ${esc(st.error)}</p>` : '') +
      `<p class="note">Same rules as the backtest: entry at the candle close, the tuned exit setup, one position per coin and timeframe, 0.07% fees. The news tilt and your overrides are not applied here — this tests the formula itself.</p>`;
  }
  // The scorecard that matters: what the formula's chosen bars did, against what
  // EVERY bar did over the same window. A rally lifts both; only skill separates them.
  function renderLogger() {
    const st = Fw.state, C = window.SIGNAL_CONFIG;
    if (!st.loaded) { $('#logger').innerHTML = '<div class="skel" style="height:80px"></div>'; return; }
    const runs = st.runs || [], now = Date.now();
    const last = runs.length ? runs[runs.length - 1] : null;
    const in24 = runs.filter((r) => now - r.at < 86400000).length;
    const failed = runs.filter((r) => now - r.at < 86400000 && !r.ok).length;
    const sinceLast = last ? (now - last.at) / 60000 : null;
    const health = !last ? ['muted', 'no runs recorded yet'] : sinceLast > 95 ? ['r', `last run ${Math.round(sinceLast / 60)}h ago — PC asleep or task stopped`] : ['g', 'running'];
    $('#lg-meta').innerHTML = `<b class="${health[0]}">${health[1]}</b> · ${in24}/24 sweeps in the last day${failed ? ` · ${failed} failed` : ''}`;

    const rows = Fw.TFS.map((tf) => {
      const b = st.bench[tf], cfg = C && C.timeframes[tf];
      const trades = st.trades.filter((t) => t.tf === tf), s = Fw.stats(trades);
      if (!b || !b.bars) return [SIG_LABEL[tf] + (cfg && cfg.config.edge === 'none' ? ' <span class="dim">gated</span>' : ''), s.closed, '—', '—', '—', '<span class="dim">not measured yet</span>'];
      const edge = b.firedAvgR !== null ? b.firedAvgR - b.avgR : null;
      return [
        SIG_LABEL[tf] + (cfg && cfg.config.edge === 'none' ? ' <span class="dim">gated</span>' : ''),
        `${s.closed}<small class="muted"> / ${s.open} open</small>`,
        s.closed ? `<span class="${s.avgR > 0 ? 'g' : 'r'}">${signed(s.avgR, 2)}R</span>` : '—',
        b.firedAvgR !== null ? `${signed(b.firedAvgR, 2)}R<small class="muted"> ${b.firedBars} bars</small>` : '<span class="dim">none fired</span>',
        `${signed(b.avgR, 2)}R<small class="muted"> ${b.bars.toLocaleString()} bars</small>`,
        edge === null ? '—' : `<b class="${edge > 0 ? 'g' : 'r'}">${signed(edge, 2)}R</b>`,
      ];
    });
    const table = `<div class="table-wrap"><table class="t"><thead><tr><th></th><th>Logged</th><th>Realised</th><th>Its picks</th><th>Every bar</th><th>Skill</th></tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

    const recent = runs.slice(-8).reverse().map((r) => `<li><span class="tag ${r.ok ? 'bull' : 'bear'}">${r.ok ? '●' : '△'}</span><span class="when">${barTime(r.at, '1h')}</span><span class="lv">${r.ok ? `${r.trades} logged · ${r.open} open · ${r.closed} closed` : esc(r.note || 'failed')}</span></li>`).join('');

    $('#logger').innerHTML = table +
      `<p class="note"><b>Its picks</b> = a long from each bar the formula fired on. <b>Every bar</b> = the same trade from every bar in the window, its rules unchanged. <b>Skill</b> is the difference, and it is the only column that can't be faked by a rising market: positive means the formula chose better moments than a dart, negative means worse. <b>Realised</b> is the actual logged trades (sequential, adaptive exits), which is why it differs.</p>` +
      (recent ? `<p class="sub" style="margin:12px 0 4px">Recent sweeps</p><ul class="fw-list lg-runs">${recent}</ul>` : '') +
      (st.logger && st.logger.error ? `<p class="note r">Last reported problem: ${esc(st.logger.error)}</p>` : '');
  }

  async function runSweep(force) {
    renderForward();
    renderLogger();
    try { await Fw.sweep(force); } catch (e) { Fw.state.error = e.message; }
    await Fw.loadLoggerStatus();
    renderForward();
    renderLogger();
  }
  // ?logger=1: unattended mode used by tools/logger.ps1 — sweep, report, nothing else.
  async function loggerRun() {
    document.title = 'logger: sweeping';
    let error = null;
    try {
      await Fw.load();
      await Fw.sweep(true);
    } catch (e) {
      error = e.message;
    }
    const status = await Fw.reportStatus(error);
    window.__loggerDone = status;
    document.title = 'logger: done';
    renderForward();
  }

  // ---------------- panels ----------------
  const callWord = (d) => (d > 0 ? 'LONG' : d < 0 ? 'SHORT' : 'WAIT');
  const callCls = (d) => (d > 0 ? 'long' : d < 0 ? 'short' : 'wait');
  const dirWord = (d) => (d > 0 ? 'long' : 'short');
  const price = () => (state.tickers[state.coin] ? state.tickers[state.coin].price : state.analysis ? state.analysis.close : NaN);

  function renderSignal(a, d) {
    const c = coinOf(state.coin), tf = sigTf();
    const strength = Math.min(1, Math.abs(d.score) / a.maxScore), thetaPos = Math.min(1, (d.dir > 0 ? d.theta[0] : d.theta[1]) / a.maxScore);
    const parts = d.groups.slice().sort((x, y) => Math.abs(y.points) - Math.abs(x.points)).filter((g) => Math.abs(g.points) >= 0.0005).map((g) => `${signed(g.points * 100, 1)} ${g.label.toLowerCase()}`);
    const bar = d.dir > 0 ? d.theta[0] : d.theta[1];
    let word = callWord(d.call), cls = callCls(d.call);
    let sub = d.call ? `${dirWord(d.call)} bias · score beyond the ${d.dir > 0 ? '+' : MINUS}${bar} bar` : `leaning ${dirWord(d.lean)} · inside the ${d.dir > 0 ? '+' : MINUS}${bar} bar, no call yet`;
    if (d.gated) {
      word = 'NO EDGE';
      cls = 'wait';
      sub = `${SIG_LABEL[tf]} has no tested edge after fees · formula says ${callWord(d.rawCall)} · ${NO_EDGE_TF[tf]}`;
    }
    const custom = paramsFor(tf);
    const overridden = (custom.theta && (custom.theta[0] !== a.cfg.config.theta[0] || custom.theta[1] !== a.cfg.config.theta[1])) || custom.exit === 'fixed';
    $('#signal').innerHTML = `
      <div class="call ${cls}">${word}<small>${sub}</small></div>
      <div class="strength" title="Score strength: |${d.score.toFixed(2)}| of ${a.maxScore}"><i style="left:0;width:${(strength * 100).toFixed(1)}%"></i><em style="left:${(thetaPos * 100).toFixed(1)}%"></em></div>
      <p class="prob">Estimated probability this <b>${dirWord(d.dir)}</b> works out: <b class="big">${pctAbs(d.p)}</b></p>
      <p class="tiny">${(d.base * 100).toFixed(1)} base ${parts.join(' ')}</p>
      <div class="rows compact">
        <div class="row"><span>${c.ticker}/USD</span><b id="sig-price">${usd(price())}</b></div>
        <div class="row"><span>Composite score</span><b><span class="${d.score > 0 ? 'g' : d.score < 0 ? 'r' : ''}">${signed(d.score, 2)}</span> / ${a.maxScore} · bar ${fmtTheta(d.theta)}${overridden ? ' <span class="untested">custom</span>' : ''}</b></div>
        ${d.tilt ? `<div class="row"><span>Tested formula alone</span><b>${callWord(d.callTested)} · ${pctAbs(d.pTested)} <span class="untested">news tilt ${signed(d.tilt, 2)}</span></b></div>` : ''}
        <div class="row"><span>Updated</span><b id="sig-time">${clock(a.computedAt)} · every 60s</b></div>
      </div>
      <p class="line basis">${Sg.SIGNALS.length} signals · tuned 2021–${monthYear(a.cfg.windows.holdoutStart)} · verified ${monthYear(a.cfg.windows.holdoutStart)}→now · ${SIG_LABEL[tf]} candle closed ${barTime(a.t + a.barMs, tf)}</p>`;
  }

  function renderRisk(a, d) {
    const cfg = a.cfg.config, cb = d.combo, px = price();
    const lv = Sg.levels(px, a.atr, d.dir, cb, { support: a.support, resistance: a.resistance });
    const fee = (2 * cfg.feePct) / 100;
    const rewardPct = lv.rewardPct !== null ? lv.rewardPct : lv.riskPct * d.b;
    const ev = d.p * rewardPct - (1 - d.p) * lv.riskPct - fee;
    const why = d.exitMode === 'adaptive' ? `adaptive · ${d.exitReason}` : d.exitMode === 'override' ? 'your setup' : d.exitReason;
    const manage = Sg.manageText(cb);
    $('#risk').innerHTML = `
      <p class="sub y">Trade levels (${dirWord(d.dir)} bias · ${comboLabel(cb)})${d.call ? '' : ' · no call yet'}</p>
      <div class="rows">
        <div class="row"><span>Entry (~current)</span><b id="lv-entry">${usd(lv.entry)}</b></div>
        <div class="row"><span>Stop Loss${cb.stopMode === 'trail' ? ' (initial)' : ''}</span><b class="r" id="lv-stop">${usd(lv.stop)}<small>${pct(-d.dir * lv.riskPct)}</small></b></div>
        <div class="row"><span>Take Profit</span><b class="g" id="lv-target">${lv.target !== null ? `${usd(lv.target)}<small>${pct(d.dir * lv.rewardPct)}</small>` : 'none · ride the trailing stop'}</b></div>
        <div class="row"><span>Risk : Reward</span><b>${cb.rr ? `1 : ${cb.rr}` : `~1 : ${d.b.toFixed(1)} <small class="muted">avg win on train</small>`}</b></div>
        <div class="row"><span>Profit per $1 (expected)</span><b class="${ev >= 0 ? 'g' : 'r'}" id="lv-ev">${(ev >= 0 ? '+' : MINUS) + '$' + Math.abs(ev).toFixed(4)}</b></div>
        <div class="row"><span>Suggested risk</span><b class="${d.risk > 0 ? 'y' : ''}">${d.risk > 0 ? `${(d.risk * 100).toFixed(2)}% of account` : 'none (odds too thin)'} <small class="muted">¼ Kelly, cap ${((cfg.kellyCap || 0.02) * 100).toFixed(0)}%</small></b></div>
        <div class="row"><span>Breakeven win rate</span><b>${cb.breakeven !== null ? pctAbs(cb.breakeven) : '—'} <small class="muted">time-out ${horizonText(a.tf, cfg.maxBars)}</small></b></div>
        <div class="row"><span>Exit chosen by</span><b class="${d.exitMode === 'override' ? 'y' : ''}">${esc(why)}</b></div>
      </div>
      ${manage ? `<p class="note">Manage: ${esc(manage)}.</p>` : ''}`;
  }

  function updateLiveLevels() {
    const a = state.analysis, d = state.derived;
    if (!a || a.symbol !== state.coin || !d) return;
    const px = price();
    if (!Number.isFinite(px)) return;
    const lv = Sg.levels(px, a.atr, d.dir, d.combo, { support: a.support, resistance: a.resistance });
    const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };
    set('#sig-price', usd(px));
    set('#lv-entry', usd(lv.entry));
    set('#lv-stop', `${usd(lv.stop)}<small>${pct(-d.dir * lv.riskPct)}</small>`);
    if (lv.target !== null) set('#lv-target', `${usd(lv.target)}<small>${pct(d.dir * lv.rewardPct)}</small>`);
  }

  function renderBreakdown(a, d) {
    const maxG = Math.max(0.5, ...d.groups.map((g) => Math.abs(g.score)));
    const rows = d.groups.map((g) => `<div class="grp ${g.untested ? 'is-untested' : ''}" title="${esc(g.desc)}"><span>${g.label}${g.untested ? ' <span class="untested">untested</span>' : ''}</span><div class="cbar"><i class="${g.score >= 0 ? 'pos' : 'neg'}" style="width:${((Math.abs(g.score) / maxG) * 50).toFixed(1)}%"></i></div><b class="${g.score > 0 ? 'g' : g.score < 0 ? 'r' : 'muted'}">${signed(g.score, 2)}</b></div>`).join('');
    const subs = d.subs.slice().sort((x, y) => Math.abs(y.product) - Math.abs(x.product));
    $('#breakdown').innerHTML = rows + `
      <details class="subs"><summary>All ${Sg.SIGNALS.length} signals · reading × weight</summary><table>
        <tr><td class="dim">signal</td><td class="dim">reading</td><td class="dim">weight</td><td class="dim">score</td></tr>
        ${subs.map((s) => `<tr title="${esc(s.desc)}"><td>${s.label}</td><td>${signed(s.value, 2)}</td><td>${s.weight ? signed(s.weight, 2) : '<span class="dim">off</span>'}</td><td class="${s.product > 0 ? 'g' : s.product < 0 ? 'r' : 'dim'}">${signed(s.product, 2)}</td></tr>`).join('')}
      </table></details>
      <p class="note">ML model alone: ${pctAbs(a.ml)} chance of a rise over the next ${a.cfg.config.H} candles. Negative weights mean the tuner found the signal works inverted.</p>`;
  }

  function renderTested(a, d) {
    const cfg = a.cfg.config, tf = sigTf();
    const h = a.cfg.holdout, hr = a.cfg.holdoutRecent, hf = a.cfg.holdoutFixed, pb = a.cfg.holdoutPerBar, mk = a.cfg.holdoutMakerFees, b = a.cfg.baselineHoldout, m = a.cfg.mlOnlyHoldout;
    const edge = cfg.edge === 'edge' ? ['g', 'Real but modest edge'] : cfg.edge === 'weak' ? ['y', 'Positive, could be luck'] : ['r', 'No reliable edge after fees'];
    const stat = (k, v, s, cls) => `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div><div class="s">${s}</div></div>`;
    let custom = '';
    if (d.exitMode === 'override') {
      const ch = d.combo.holdout;
      custom = `<p class="note"><b class="y">Your exit override</b> (${comboLabel(d.combo)}) on the same period, every signal bar: ${signed(ch.avgR, 3)}R per trade, win ${pctAbs(ch.winRate)}, ${ch.trades.toLocaleString()} bars.</p>`;
    }
    $('#tested').innerHTML = `
      <p class="line muted" style="margin:0 0 10px">${SIG_LABEL[tf]} · ${monthYear(a.cfg.windows.holdoutStart)} → ${monthYear(a.cfg.windows.end)} · ${a.cfg.symbols.map((s) => s.replace('USDT', '')).join(', ')} · after fees · <b class="${edge[0]}">${edge[1]}</b></p>
      <div class="stat-grid">
        ${stat('Avg result / trade', signed(h.avgR, 3) + 'R', `${h.trades} trades · t = ${h.tstat.toFixed(2)}`, h.avgR > 0 ? 'g' : 'r')}
        ${stat(`Since ${monthYear(a.cfg.windows.recentStart)}`, hr && hr.trades ? signed(hr.avgR, 3) + 'R' : '—', hr && hr.trades ? `${hr.trades} trades · win ${pctAbs(hr.winRate)}` : 'no trades yet', hr && hr.avgR > 0 ? 'g' : 'r')}
        ${stat('Win rate', pctAbs(h.winRate), cfg.adaptive ? 'adaptive exits' : cfg.base.breakeven !== null ? `breakeven ${pctAbs(cfg.base.breakeven)} at 1:${cfg.base.rr}` : 'trailing exits', cfg.base.breakeven === null || h.winRate > cfg.base.breakeven ? 'g' : 'r')}
        ${stat('Return risking 1%/trade', pct(h.return1pct, 1), `¼-Kelly sizing ${pct(h.returnKelly, 1)} · max DD ${h.maxDrawdownR.toFixed(0)}R`, h.return1pct > 0 ? 'g' : 'r')}
      </div>
      <p class="note">Next-candle direction ${pctAbs(pb.allAccuracy)} on every bar (50% = coin flip). With maker fees (${cfg.makerFeePct}%) instead of ${cfg.feePct}%: ${signed(mk.avgR, 3)}R per signal bar vs ${signed(pb.avgR, 3)}R. Same period: ${cfg.adaptive ? `fixed exits ${signed(hf.avgR, 3)}R/trade, ` : ''}equal weights ${signed(b.avgR, 3)}R/trade, ML model alone ${signed(m.avgR, 3)}R/trade. News tilt and event bias are not in these numbers.</p>${custom}`;
  }

  // ---------------- parameters panel ----------------
  function renderParams(a) {
    const cfg = a.cfg.config, tf = sigTf(), pm = paramsFor(tf);
    const theta = Array.isArray(pm.theta) ? pm.theta : cfg.theta;
    const exit = pm.exit === 'fixed' ? 'fixed' : 'adaptive';
    const combos = Object.values(cfg.combos).slice().sort((x, y) => y.holdout.avgR - x.holdout.avgR);
    const cur = cfg.combos[pm.combo] || cfg.combos[cfg.base.key];
    const cap = Number.isFinite(pm.cap) ? pm.cap : News.HEADLINE_CAP;
    const tested = exit === 'fixed'
      ? `<b>${comboLabel(cur)}</b> on unseen data, every signal bar: <b>${signed(cur.holdout.avgR, 3)}R</b> per trade, win ${pctAbs(cur.holdout.winRate)}${cur.breakeven !== null ? ` (breakeven ${pctAbs(cur.breakeven, 0)})` : ''}, ${cur.holdout.trades.toLocaleString()} bars, t = ${cur.holdout.tstat.toFixed(2)}.`
      : `<b>${cfg.adaptive ? 'Adaptive exits' : comboLabel(cfg.combos[cfg.base.key])}</b> (what the tuner chose) on unseen data: <b>${signed(a.cfg.holdout.avgR, 3)}R</b> per trade, win ${pctAbs(a.cfg.holdout.winRate)}, ${a.cfg.holdout.trades} trades.`;
    const thRow = cfg.thetaTable.find((x) => x.theta === theta[0] && theta[0] === theta[1]);
    $('#params').innerHTML = `
      ${cfg.edge === 'none' ? `<div class="prow"><span>No-edge gate</span><div class="ctl"><label><input type="checkbox" id="pm-show" ${pm.showCalls ? 'checked' : ''}> show LONG / SHORT calls anyway on ${SIG_LABEL[tf]} (no tested edge after fees)</label></div></div>` : ''}
      <div class="prow"><span>Exit policy</span><div class="ctl"><select id="pm-exit"><option value="adaptive" ${exit === 'adaptive' ? 'selected' : ''}>${cfg.adaptive ? 'Adaptive per signal (tested)' : 'Tuned setup (tested)'}</option><option value="fixed" ${exit === 'fixed' ? 'selected' : ''}>Fixed, my choice</option></select></div></div>
      <div class="prow" ${exit === 'fixed' ? '' : 'hidden'}><span>Stop &amp; target</span><div class="ctl"><select id="pm-combo">${combos.map((cb) => `<option value="${cb.key}" ${cb.key === cur.key ? 'selected' : ''}>${comboLabel(cb)} · ${signed(cb.holdout.avgR, 3)}R</option>`).join('')}</select></div></div>
      <div class="prow"><span>Strong-call bar</span><div class="ctl">long <input type="number" id="pm-thl" step="0.25" min="0" max="${cfg.maxScore}" value="${theta[0]}"> short <input type="number" id="pm-ths" step="0.25" min="0" max="${cfg.maxScore}" value="${theta[1]}"> <span class="muted">tuned ${fmtTheta(cfg.theta)}${thRow ? ` · at ±${thRow.theta}: ${signed(thRow.avgR, 3)}R on ${thRow.trades.toLocaleString()} bars` : ''}</span></div></div>
      <div class="prow"><span>News tilt cap</span><div class="ctl"><input type="range" id="pm-cap" min="0" max="1.5" step="0.25" value="${cap}"> <b id="pm-cap-v">±${cap.toFixed(2)}</b> <span class="muted">headline tilt limit (0 = off)</span></div></div>
      <div class="prow"><span>Time-out</span><div class="ctl"><b>${cfg.maxBars} candles</b> <span class="muted">(${horizonText(a.tf, cfg.maxBars)}, fixed in testing)</span></div></div>
      <p class="tested-line">${tested}</p>
      <button class="tbtn" id="pm-reset" type="button">Reset to tuned</button>`;
  }

  function onParamChange(e) {
    const tf = sigTf(), id = e.target.id, cfg = state.analysis && state.analysis.cfg.config;
    if (!cfg) return;
    if (id === 'pm-exit') setParams(tf, { exit: e.target.value });
    else if (id === 'pm-combo') { if (cfg.combos[e.target.value]) setParams(tf, { combo: e.target.value, exit: 'fixed' }); }
    else if (id === 'pm-show') setParams(tf, { showCalls: e.target.checked });
    else if (id === 'pm-thl' || id === 'pm-ths') {
      const l = +$('#pm-thl').value, s = +$('#pm-ths').value;
      if (Number.isFinite(l) && Number.isFinite(s) && l >= 0 && s >= 0) setParams(tf, { theta: [l, s] });
    } else if (id === 'pm-cap') setParams(tf, { cap: +e.target.value });
    else return;
    rerender();
    renderNews();
  }

  function renderLoading() {
    $('#signal').innerHTML = '<div class="call wait skel">&nbsp;</div><div class="skel" style="height:14px;margin:0 0 10px"></div><div class="skel" style="height:60px"></div>';
    ['#risk', '#breakdown', '#tested'].forEach((s) => ($(s).innerHTML = '<div class="skel" style="height:110px"></div>'));
  }
  function renderNotTuned() {
    $('#signal').innerHTML = `<div class="empty"><h3>Signal engine not tuned yet</h3>Run <code>serve.cmd</code>, then open <a href="tune.html">tune.html</a> and click <b>Tune signal engine</b>. It builds the formula from history and saves it here.</div>`;
    ['#risk-pane', '#breakdown-pane', '#tested-pane'].forEach((s) => ($(s).hidden = true));
    $('#params').innerHTML = '';
  }
  function renderError(msg) {
    $('#signal').innerHTML = `<div class="empty"><h3>Could not load market data</h3>${esc(msg)}<br><button class="tbtn" type="button" style="margin-top:10px" data-retry>Try again</button></div>`;
    ['#risk-pane', '#breakdown-pane', '#tested-pane'].forEach((s) => ($(s).hidden = true));
  }
  function rerender() {
    const a = state.analysis;
    if (!a || a.symbol !== state.coin) return;
    const d = (state.derived = Eng.derive(a, newsTilt().total, paramsFor(sigTf())));
    ['#risk-pane', '#breakdown-pane', '#tested-pane'].forEach((s) => ($(s).hidden = false));
    renderSignal(a, d);
    renderRisk(a, d);
    renderBreakdown(a, d);
    renderTested(a, d);
    renderParams(a);
    renderStats();
    const t = state.tickers[state.coin];
    document.title = `${coinOf(state.coin).ticker}${t ? ' ' + fmtPrice(t.price) : ''} · ${callWord(d.call)}`;
  }

  // ---------------- refresh ----------------
  async function refresh(showLoading) {
    const coin = state.coin, tf = sigTf(), run = ++state.run;
    if (!Eng.configFor(tf)) return renderNotTuned();
    if (showLoading) renderLoading();
    else { const t = $('#sig-time'); if (t) t.classList.add('updating'); }
    $('#refresh').disabled = true;
    try {
      const a = await Eng.analyze(coin, tf);
      if (run !== state.run) return;
      state.analysis = a;
      rerender();
      renderNews();
    } catch (err) {
      if (run !== state.run) return;
      state.analysis = null;
      state.derived = null;
      renderError(err.message || String(err));
    } finally {
      if (run === state.run) $('#refresh').disabled = false;
    }
  }

  function setCoin(symbol) {
    if (symbol === state.coin) return;
    state.coin = symbol;
    state.analysis = null;
    state.derived = null;
    writeHash();
    mountTv();
    renderStats();
    renderNews();
    refresh(true);
  }
  function setTf(tf) {
    const prevSig = sigTf();
    if (tf === state.tf) return;
    state.tf = tf;
    writeHash();
    renderControls();
    mountTv();
    if (sigTf() !== prevSig) { state.analysis = null; state.derived = null; renderStats(); refresh(true); }
    else rerender();
  }

  $('#coin').addEventListener('change', (e) => setCoin(e.target.value));
  $('#tfs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tf]'); if (b) setTf(b.dataset.tf); });
  $('#refresh').addEventListener('click', () => { refresh(false); loadNews(); });
  $('#params-toggle').addEventListener('click', () => {
    const p = $('#params'), open = p.hidden;
    p.hidden = !open;
    $('#params-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#params').addEventListener('change', onParamChange);
  $('#params').addEventListener('input', (e) => { if (e.target.id === 'pm-cap') $('#pm-cap-v').textContent = '±' + (+e.target.value).toFixed(2); });
  $('#params').addEventListener('click', (e) => {
    if (e.target.id === 'pm-reset') { setParams(sigTf(), null); rerender(); renderNews(); }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) refresh(true); });
  $('#news').addEventListener('change', (e) => {
    if (e.target.id === 'ev-bias' || e.target.id === 'ev-note') {
      News.setBias(state.coin, +$('#ev-bias').value, $('#ev-note').value);
      renderNews();
      rerender();
    }
  });
  window.addEventListener('hashchange', () => {
    const prev = { coin: state.coin, tf: state.tf };
    parseHash();
    if (prev.coin !== state.coin || prev.tf !== state.tf) {
      renderControls();
      mountTv();
      state.analysis = null;
      state.derived = null;
      renderStats();
      renderNews();
      refresh(true);
    }
  });

  function loadTickers() {
    return Dt.tickers(COINS.map((c) => c.symbol)).then((t) => {
      Object.assign(state.tickers, t);
      renderStats();
      updateLiveLevels();
    }).catch(() => {});
  }
  function onTick(t) {
    state.tickers[t.symbol] = t;
    if (t.symbol !== state.coin) return;
    updateLiveLevels();
    const cells = document.querySelectorAll('#stats .v');
    if (cells.length >= 3) {
      cells[0].textContent = usd(t.high);
      cells[1].textContent = usd(t.low);
      cells[2].textContent = compact(t.quoteVolume);
    }
    document.title = `${coinOf(t.symbol).ticker} ${fmtPrice(t.price)} · ${state.derived ? callWord(state.derived.call) : 'Signal'}`;
  }

  $('#fw-sweep').addEventListener('click', () => runSweep(true));

  // ---------------- init ----------------
  parseHash();
  loadParams();
  renderControls();
  if (new URLSearchParams(location.search).has('logger')) {
    $('#tv').innerHTML = '<div class="tv-fallback">Logger mode: sweeping the forward test…</div>';
    renderNotTuned();
    renderForward();
    renderLogger();
    if (window.SIGNAL_CONFIG) loggerRun(); else Fw.reportStatus('signal engine not tuned');
  } else {
    writeHash();
    mountTv();
    renderStats();
    renderNews();
    renderForward();
    renderLogger();
    loadTickers();
    loadNews();
    Dt.liveTickers(COINS.map((c) => c.symbol), onTick, (on) => { state.live = on; });
    refresh(true).then(() => window.SIGNAL_CONFIG && Fw.load().then(() => runSweep(true)));
    setInterval(() => refresh(false), REFRESH_MS);
    setInterval(loadNews, 300000);
    setInterval(() => { if (Fw.state.loaded) runSweep(false); }, 300000);
    setInterval(() => { if (!state.live) loadTickers(); }, 30000);
  }
})();
