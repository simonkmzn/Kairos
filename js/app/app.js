(function () {
  'use strict';
  const K = window.KAIROS;
  const Dt = K.data, F = K.features, E = K.engine;
  const $ = (s) => document.querySelector(s);
  const COINS = Dt.COINS;
  const TFS = ['15m', '1h', '4h', '1d', '1w'];
  const MINUS = '−';
  const RESEARCH = window.KAIROS_RESEARCH || null;
  const state = { coin: 'BTCUSDT', tf: '4h', venue: 'perp', tickers: {}, analyses: new Map(), pending: new Map(), live: false, tvKey: '' };

  // ---------------- formatting ----------------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtPrice(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v), d = a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : 5;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const usd = (v) => '$' + fmtPrice(v);
  const pct = (v, d = 1) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%' : '—');
  const pctAbs = (v, d = 0) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
  const num = (v, d = 2) => (Number.isFinite(v) ? (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d) : '—');
  const compact = (v) => (v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v).toLocaleString('en-US'));
  const coinOf = (s) => COINS.find((c) => c.symbol === s);
  const key = (s, tf) => `${s}|${tf}`;
  const monthYear = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  function timeFmt(t, tf, full) {
    const daily = tf === '1d' || tf === '1w';
    return new Date(t).toLocaleString('en-US', daily
      ? { month: 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}) }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function horizonText(tf, H) {
    const hours = (Dt.INTERVALS[tf].ms * H) / 3600000;
    if (hours < 24 || hours % 24) return `${hours} hours`;
    return hours === 24 ? '24 hours' : `${hours / 24} days`;
  }
  function durationText(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  }
  const icon = (c, cls) => `<span class="coin-icon ${cls || ''}" data-t="${c.ticker[0]}"><img src="https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${c.ticker.toLowerCase()}.svg" alt="" loading="lazy" onerror="this.remove()"></span>`;
  const venueName = (v) => (v === 'spot' ? 'Spot' : 'Futures');

  // ---------------- tooltips ----------------
  const FEATURE_TIPS = {
    ret_1: 'How much the last candle moved, compared with this coin’s normal candle size.',
    ret_4: 'The move over the last 4 candles, scaled by how volatile the coin normally is.',
    ret_12: 'The move over the last 12 candles, scaled by normal volatility.',
    ret_48: 'The move over the last 48 candles, scaled by normal volatility.',
    ret_168: 'The move over the last 168 candles, scaled by normal volatility.',
    ema20_gap: 'How far price is from its 20-candle average, measured in typical candle ranges.',
    ema50_gap: 'How far price is from its 50-candle average, measured in typical candle ranges.',
    ema200_gap: 'How far price is from its 200-candle average: the longer-term trend.',
    rsi14: 'RSI: a 0–100 gauge of recent buying vs selling pressure. The model learned from history whether high readings led to more upside or a pullback.',
    bb_pctb: 'Where price sits inside its normal 20-candle range (Bollinger Bands): near the top or the bottom.',
    macd: 'MACD: whether short-term momentum is speeding up or fading.',
    vol_regime: 'Whether moves have recently been bigger than usual (volatility expanding) or smaller (calm).',
    volume_z: 'Trading volume on the last candle compared with normal.',
    clv: 'Where the last candle closed inside its high–low range. Near the high suggests buying pressure; near the low, selling pressure.',
    range_z: 'How big the last candle’s high–low range was compared with normal.',
    dd_100: 'How far price is below its highest point of the last 100 candles.',
    rebound_100: 'How far price is above its lowest point of the last 100 candles.',
    btc_ret_4: 'Bitcoin’s move over the last 4 candles. Most coins follow Bitcoin.',
    btc_ret_48: 'Bitcoin’s move over the last 48 candles.',
    funding: 'Futures funding rate. Positive means traders pay to hold longs (crowded bullish bets); negative means shorts are paying.',
    funding_3d: 'The futures funding rate averaged over the last 3 days.',
    dow: 'Day of the week. Crypto has some weekday vs weekend patterns.',
    hour: 'Time of day. Activity shifts between Asian, European and US trading hours.',
  };
  K.tooltips.init({
    venue: 'Spot = you can only buy or sell the coin itself (no shorting), 0.15% cost per trade assumed. Futures = 1× perpetual futures, so the model can also go short; 0.07% per trade plus funding payments assumed.',
    prob: 'The model’s estimated chance that the price will be higher at the end of the forecast window. 50% = no idea. Real edges in markets are small, so readings far from 50% are rare.',
  });

  // ---------------- state <-> URL ----------------
  function parseHash() {
    const parts = decodeURIComponent(location.hash.slice(1)).split('/');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kairos.view') || '{}'); } catch (e) { /* storage blocked */ }
    const tk = (parts[0] || saved.ticker || 'BTC').toUpperCase();
    state.coin = (COINS.find((c) => c.ticker === tk) || COINS[0]).symbol;
    const tf = parts[1] || saved.tf;
    state.tf = TFS.includes(tf) ? tf : '4h';
    const venue = parts[2] || saved.venue;
    state.venue = venue === 'spot' ? 'spot' : 'perp';
  }
  function writeHash() {
    const c = coinOf(state.coin);
    const h = `#${c.ticker}/${state.tf}/${state.venue === 'spot' ? 'spot' : 'futures'}`;
    if (location.hash !== h) history.replaceState(null, '', h);
    try { localStorage.setItem('kairos.view', JSON.stringify({ ticker: c.ticker, tf: state.tf, venue: state.venue })); } catch (e) { /* storage blocked */ }
  }

  // ---------------- top controls ----------------
  function renderControls() {
    $('#tf-seg').innerHTML = TFS.map((tf) => {
      const d = Dt.INTERVALS[tf];
      return `<button type="button" role="radio" aria-checked="${tf === state.tf}" data-tf="${tf}" title="${d.model ? 'Chart + forecast' : 'Chart only'}">${d.label}${d.model ? '<i class="mdot" aria-hidden="true"></i>' : ''}</button>`;
    }).join('');
    $('#venue-seg').innerHTML = ['spot', 'perp'].map((v) => `<button type="button" role="radio" aria-checked="${v === state.venue}" data-venue="${v}">${venueName(v)}</button>`).join('') +
      '<button class="tip" type="button" data-tip="venue" aria-label="Spot vs futures" style="margin:auto 6px auto 4px">?</button>';
  }

  // ---------------- watchlist & header ----------------
  function callOf(v) {
    if (v.longShort) return v.pos > 0 ? { word: 'LONG', cls: 'long' } : v.pos < 0 ? { word: 'SHORT', cls: 'short' } : { word: 'WAIT', cls: 'flat' };
    if (v.pos > 0) return { word: 'BUY', cls: 'long' };
    if (v.p <= 0.5 - v.tau) return { word: 'SELL', cls: 'short' };
    return { word: 'WAIT', cls: 'flat' };
  }

  function renderWatchlist() {
    const hasModel = Dt.INTERVALS[state.tf].model && E.tfBundle(state.tf);
    $('#watch-tf').textContent = hasModel ? `${Dt.INTERVALS[state.tf].label} · ${venueName(state.venue)}` : '24h change';
    $('#watchlist').innerHTML = COINS.map((c) => {
      const t = state.tickers[c.symbol];
      const chg = t ? t.price / t.open - 1 : NaN;
      let pill = '';
      if (hasModel) {
        const a = state.analyses.get(key(c.symbol, state.tf));
        if (a && a.venues) {
          const call = callOf(a.venues[state.venue]);
          pill = `<span class="pill ${call.cls === 'flat' ? 'wait' : call.cls}">${call.word}</span>`;
        } else pill = `<span class="pill skel">&nbsp;</span>`;
      }
      return `<button class="wrow" type="button" data-symbol="${c.symbol}" aria-current="${c.symbol === state.coin}">
        ${icon(c)}
        <span class="w-id"><span class="tk">${c.ticker}</span><span class="nm">${c.name}</span></span>
        <span class="w-q"><span class="px" data-px="${c.symbol}">${t ? fmtPrice(t.price) : '—'}</span>
          <span class="meta"><span class="chg ${chg >= 0 ? 'up' : 'down'}" data-chg="${c.symbol}">${t ? pct(chg, 2) : ''}</span>${pill}</span></span>
      </button>`;
    }).join('');
  }

  function renderHeader() {
    const c = coinOf(state.coin), t = state.tickers[state.coin];
    const chg = t ? t.price / t.open - 1 : NaN;
    $('#asset').innerHTML = `${icon(c, 'lg')}<div>
      <div class="asset-name">${c.name}<span>${c.ticker} / USDT</span></div>
      <div class="asset-price"><span class="big" id="hdr-px">${t ? fmtPrice(t.price) : '—'}</span><span class="chg ${chg >= 0 ? 'up' : 'down'}" id="hdr-chg">${t ? pct(chg, 2) : ''}</span></div>
    </div>`;
    const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('#asset-stats').innerHTML = t ? kv('24h high', fmtPrice(t.high)) + kv('24h low', fmtPrice(t.low)) + kv('24h volume', compact(t.quoteVolume)) : '';
    if (t) document.title = `${c.ticker} ${fmtPrice(t.price)} · Kairos`;
  }

  function onTick(t) {
    state.tickers[t.symbol] = t;
    const chg = t.price / t.open - 1;
    const px = document.querySelector(`[data-px="${t.symbol}"]`);
    if (px) px.textContent = fmtPrice(t.price);
    const ch = document.querySelector(`[data-chg="${t.symbol}"]`);
    if (ch) {
      ch.textContent = pct(chg, 2);
      ch.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
    }
    if (t.symbol === state.coin) {
      const hp = $('#hdr-px'), hc = $('#hdr-chg');
      if (hp) hp.textContent = fmtPrice(t.price);
      else renderHeader();
      if (hc) {
        hc.textContent = pct(chg, 2);
        hc.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
      }
      document.title = `${coinOf(t.symbol).ticker} ${fmtPrice(t.price)} · Kairos`;
    }
  }

  // ---------------- TradingView ----------------
  function mountTv() {
    const box = $('#tv');
    const k = state.coin + state.tf;
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
      symbol: 'BINANCE:' + state.coin, interval: Dt.INTERVALS[state.tf].tv, timezone: tz,
      theme: 'dark', style: '1', locale: 'en',
      toolbar_bg: '#0d1119', backgroundColor: '#0b0f16', gridColor: 'rgba(255,255,255,0.04)',
      enable_publishing: false, allow_symbol_change: false, hide_side_toolbar: false, withdateranges: true, save_image: false,
    });
  }
  window.__tvReady = () => { state.tvKey = ''; mountTv(); };
  setTimeout(() => {
    if (!window.TradingView && $('#tv .tv-fallback')) $('#tv').innerHTML = '<div class="tv-fallback">The TradingView chart couldn’t load. Check your internet connection or ad blocker. The Kairos forecast below still works.</div>';
  }, 12000);

  // ---------------- analyses ----------------
  function ensureAnalysis(symbol, tf, force) {
    if (!Dt.INTERVALS[tf].model || !E.tfBundle(tf)) return Promise.resolve(null);
    const k = key(symbol, tf);
    const cur = state.analyses.get(k);
    if (!force && cur && Date.now() < cur.nextCloseAt + 5000) return Promise.resolve(cur);
    if (state.pending.has(k)) return state.pending.get(k);
    const pr = E.analyze(symbol, tf)
      .then((a) => { state.analyses.set(k, a); return a; })
      .catch((err) => {
        const a = { error: err.message || String(err), nextCloseAt: Date.now() + 20000 };
        state.analyses.set(k, a);
        return a;
      })
      .finally(() => state.pending.delete(k));
    state.pending.set(k, pr);
    return pr;
  }

  async function refreshSelected(force) {
    const { coin, tf } = state;
    if (!Dt.INTERVALS[tf].model) return renderChartOnly();
    if (!E.tfBundle(tf)) return renderNotTrained();
    if (force || !state.analyses.has(key(coin, tf))) renderLoading();
    const a = await ensureAnalysis(coin, tf, force);
    if (state.coin !== coin || state.tf !== tf) return;
    renderPanels(a);
    renderWatchlist();
  }

  async function refreshWatchlist() {
    const tf = state.tf;
    if (!Dt.INTERVALS[tf].model || !E.tfBundle(tf)) return;
    const queue = COINS.map((c) => c.symbol);
    let i = 0;
    const worker = async () => {
      while (i < queue.length && state.tf === tf) {
        const s = queue[i++];
        const before = state.analyses.get(key(s, tf));
        const a = await ensureAnalysis(s, tf);
        if (a !== before && state.tf === tf) renderWatchlist();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ---------------- panels ----------------
  const panelIds = ['#range', '#drivers', '#record'];
  function showPanels(on) { panelIds.forEach((s) => ($(s).hidden = !on)); }

  function renderLoading() {
    const c = coinOf(state.coin);
    $('#signal').className = 'card signal-card';
    $('#signal').innerHTML = `<div class="sig-top"><span class="eyebrow">Signal</span><span class="ctx">${c.ticker} · ${Dt.INTERVALS[state.tf].label} · ${venueName(state.venue)}</span></div>
      <div class="skel" style="height:56px;width:60%;margin:18px auto 0"></div><div class="skel" style="height:120px;margin:18px 10px 0"></div><div class="skel" style="height:44px;margin:16px 0 0"></div>`;
    showPanels(true);
    panelIds.forEach((s) => ($(s).innerHTML = '<div class="skel" style="height:14px;width:40%"></div><div class="skel" style="height:90px;margin-top:14px"></div>'));
    const fc = $('#forecast-chart');
    fc.__d = null;
    fc.innerHTML = '<div class="skel" style="position:absolute;inset:0"></div>';
  }

  function renderChartOnly() {
    const c = coinOf(state.coin), d = Dt.INTERVALS[state.tf];
    const alt = state.tf === '15m' ? '1h' : '1d';
    $('#signal').className = 'card signal-card';
    $('#signal').innerHTML = `<div class="sig-top"><span class="eyebrow">Signal</span><span class="ctx">${c.ticker} · ${d.label}</span></div>
      <div class="empty"><h3>Chart only on ${d.label}</h3>Forecasts run on 1H, 4H and 1D, the timeframes the model was trained and tested on.
      ${state.tf === '15m' ? 'On 15-minute candles, trading fees eat any small edge.' : 'Weekly candles don’t give enough history to test a model properly.'}
      <br><button class="btn primary" type="button" data-goto-tf="${alt}">Show the ${Dt.INTERVALS[alt].label} forecast</button></div>`;
    showPanels(false);
    const fc = $('#forecast-chart');
    fc.__d = null;
    fc.innerHTML = `<div class="empty" style="padding-top:120px">Pick <b>1H</b>, <b>4H</b> or <b>1D</b> to see the forecast chart.</div>`;
    $('#fc-sub').textContent = `${c.ticker} · no forecast on ${d.label}`;
  }

  function renderNotTrained() {
    $('#signal').className = 'card signal-card';
    $('#signal').innerHTML = `<div class="empty"><h3>Models not trained yet</h3>Run <code>serve.cmd</code>, then open <a href="research.html">research.html</a> to train and test the forecast models.</div>`;
    showPanels(false);
    $('#forecast-chart').innerHTML = '';
  }

  function renderError(msg) {
    $('#signal').className = 'card signal-card';
    $('#signal').innerHTML = `<div class="empty"><h3>Couldn’t load market data</h3>${esc(msg)}<br><button class="btn" type="button" data-retry>Try again</button></div>`;
    showPanels(false);
    const fc = $('#forecast-chart');
    fc.__d = null;
    fc.innerHTML = '';
  }

  function renderPanels(a) {
    if (!a) return renderNotTrained();
    if (a.error) return renderError(a.error);
    const v = a.venues[state.venue], c = coinOf(state.coin);
    showPanels(true);
    renderSignal(a, v, c);
    renderRange(a, v, c);
    renderDrivers(a, v);
    renderRecord(a, v, c);
    renderForecast(a, v, c);
  }

  function dialSvg(p, tau) {
    const lo = 0.3, hi = 0.7, W = 260, H = 150, cx = 130, cy = 132, r = 104;
    const f = (x) => (Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo);
    const pt = (x, rr) => [cx + rr * Math.cos(Math.PI * (1 - f(x))), cy - rr * Math.sin(Math.PI * (1 - f(x)))];
    const arc = (a0, a1) => {
      const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
      return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const dn = 0.5 - tau, up = 0.5 + tau;
    const [nx, ny] = pt(p, r - 30);
    return `<svg class="dial" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chance of a higher price ${(p * 100).toFixed(1)} percent">
      <path class="dz-down" d="${arc(lo, dn)}"/>${tau > 0 ? `<path class="dz-flat" d="${arc(dn, up)}"/>` : ''}<path class="dz-up" d="${arc(up, hi)}"/>
      ${Math.abs(p - 0.5) > 0.002 ? `<path class="dz-active ${p >= 0.5 ? 'up' : 'down'}" d="${p >= 0.5 ? arc(0.5, p) : arc(p, 0.5)}"/>` : ''}
      <text class="dz-label" x="${cx - r}" y="${cy + 18}" text-anchor="middle">30%</text>
      <text class="dz-label" x="${cx}" y="${cy - r - 14}" text-anchor="middle">50%</text>
      <text class="dz-label" x="${cx + r}" y="${cy + 18}" text-anchor="middle">70%</text>
      <line class="dz-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}"/><circle class="dz-hub" cx="${cx}" cy="${cy}" r="6"/>
    </svg>`;
  }

  function edgeInfo(a, v, c) {
    const s = v.coin, since = monthYear(a.holdoutStart);
    if (!s) return { cls: 'none', badge: 'Untested', text: 'No test results for this coin.', tip: '' };
    const h = s.holdout, bh = s.buyHold || {};
    const text = `Since ${since}, after fees: model ${pct(h.totalReturn, 0)} vs buy &amp; hold ${pct(bh.totalReturn, 0)}.`;
    const detail = `Out-of-sample test on ${c.ticker} ${Dt.INTERVALS[state.tf].label} ${venueName(state.venue).toLowerCase()}: Sharpe ${num(h.sharpe)} (buy & hold ${num(bh.sharpe)}), ${h.trades} trades, ${pctAbs(h.winRate)} winners, profit factor ${num(h.profitFactor)}.`;
    if (s.verdict === 'edge') return { cls: 'edge', badge: 'Tested edge', text, tip: `${detail} It cleared the pre-set bar: Sharpe ≥ 0.75, profit factor ≥ 1.1, and ≥ 90% confidence the result wasn’t luck.` };
    if (s.verdict === 'weak') return { cls: 'weak', badge: 'Weak edge', text, tip: `${detail} It made money but didn’t clear the bar for a reliable edge, so it could be luck.` };
    return { cls: 'none', badge: 'No edge', text, tip: `${detail} This signal did not make money here in testing. Treat it as information, not a trade.` };
  }

  function renderSignal(a, v, c) {
    const call = callOf(v);
    const card = $('#signal');
    card.className = `card signal-card ${call.cls}`;
    const bars = v.sinceIndex >= 0 ? a.last - v.sinceIndex + 1 : 0;
    let sub;
    if (v.pos !== 0 && v.sinceIndex >= 0) sub = `${v.pos > 0 ? (v.longShort ? 'Long' : 'In') : 'Short'} since ${timeFmt(a.feat.t[v.sinceIndex] + a.barMs, state.tf)} · ${bars} candle${bars === 1 ? '' : 's'}`;
    else if (call.word === 'SELL') sub = 'Odds lean down: the model stays out, in cash';
    else sub = 'Odds too close to call: no position';
    const edge = edgeInfo(a, v, c);
    card.innerHTML = `
      <div class="sig-top"><span class="eyebrow">Signal</span><span class="ctx">${c.ticker} · ${Dt.INTERVALS[state.tf].label} · ${venueName(state.venue)}</span></div>
      <div class="call ${call.cls}"><div class="call-word">${call.word}</div><div class="call-sub">${sub}</div></div>
      ${dialSvg(v.p, v.tau)}
      <div class="prob"><b>${(v.p * 100).toFixed(1)}%</b><span>chance ${c.ticker} is higher in ${horizonText(state.tf, v.H)} <button class="tip" type="button" data-tip="prob" aria-label="About this probability">?</button></span></div>
      <div class="edge ${edge.cls}"><span class="badge">${edge.badge}</span><span>${edge.text}${edge.tip ? ` <button class="tip" type="button" data-tip-text="${esc(edge.tip)}" aria-label="Test details">?</button>` : ''}</span></div>
      <div class="next"><span>Next candle in <b id="countdown">${durationText(a.nextCloseAt - Date.now())}</b></span><span>Based on <b>${timeFmt(a.lastT + a.barMs, state.tf)}</b> close</span></div>`;
  }

  function renderRange(a, v, c) {
    const end = v.cone[v.cone.length - 1], now = a.feat.close[a.last];
    const lo = end.lo80, hi = end.hi80, span = hi - lo;
    const at = (x) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
    const cs = v.coneStats;
    $('#range').innerHTML = `
      <h3>Expected range</h3><div class="sub">Where ${c.ticker} is likely to be in ${horizonText(state.tf, v.H)}</div>
      <div class="rangebar" role="img" aria-label="80% range ${usd(lo)} to ${usd(hi)}">
        <div class="b80"></div>
        <div class="b50" style="left:${at(end.lo50).toFixed(2)}%;width:${(at(end.hi50) - at(end.lo50)).toFixed(2)}%"></div>
        <div class="now" style="left:${at(now).toFixed(2)}%"></div>
        <span class="end">${fmtPrice(lo)}</span><span class="end r">${fmtPrice(hi)}</span>
      </div>
      <div class="rows">
        <div class="row"><span class="k">80% likely between</span><span class="v">${usd(lo)} – ${usd(hi)}<small>${pct(lo / now - 1)} / ${pct(hi / now - 1)}</small></span></div>
        <div class="row"><span class="k">50% likely between</span><span class="v">${usd(end.lo50)} – ${usd(end.hi50)}<small>${pct(end.lo50 / now - 1)} / ${pct(end.hi50 / now - 1)}</small></span></div>
        <div class="row"><span class="k">Middle estimate</span><span class="v">${usd(end.mid)}<small>${pct(end.mid / now - 1, 2)}</small></span></div>
      </div>
      <p class="note">Tested since ${monthYear(a.holdoutStart)}: price ended inside the 80% range <b>${pctAbs(cs.holdoutCoverage80)}</b> of the time and inside the 50% range <b>${pctAbs(cs.holdoutCoverage50)}</b>. Ranges widen automatically when the market gets volatile.</p>`;
  }

  function renderDrivers(a, v) {
    const top = v.drivers.slice(0, 6);
    const max = Math.max(0.05, ...top.map((d) => Math.abs(d.contribution)));
    $('#drivers').innerHTML = `<h3>What’s driving it</h3><div class="sub">The factors pushing the odds most right now</div>` +
      top.map((d) => {
        const w = (Math.abs(d.contribution) / max) * 50;
        const t = FEATURE_TIPS[d.id];
        return `<div class="drv"><div><div class="name">${esc(d.label)}${t ? ` <button class="tip" type="button" data-tip-text="${esc(t)}" aria-label="About ${esc(d.label)}">?</button>` : ''}</div>
          <div class="grp">${d.group} · ${d.contribution >= 0 ? 'pushes up' : 'pushes down'}</div></div>
          <div class="dbar"><span class="${d.contribution >= 0 ? 'pos' : 'neg'}" style="width:${w.toFixed(1)}%"></span></div></div>`;
      }).join('') +
      `<p class="note">One model learns these weights from all 12 coins at once and is re-trained as markets change.</p>`;
  }

  function sparkSvg(model, bh) {
    if (!model || !model.length) return '';
    const W = 320, H = 86, all = model.concat(bh || []);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 0.05;
    lo -= pad;
    hi += pad;
    const line = (arr) => arr.map((v, i) => `${((i / (arr.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / (hi - lo)) * H).toFixed(1)}`).join(' ');
    const y1 = H - ((1 - lo) / (hi - lo)) * H;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Model equity vs buy and hold">
      <defs><linearGradient id="spark-g" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#c084fc"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${bh ? `<polyline points="${line(bh)}" fill="none" stroke="#6f7890" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : ''}
      <polyline points="${line(model)}" fill="none" stroke="url(#spark-g)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function renderRecord(a, v, c) {
    const s = v.coin;
    if (!s) {
      $('#record').innerHTML = '<h3>Tested track record</h3><p class="note">No test results for this coin.</p>';
      return;
    }
    const h = s.holdout, bh = s.buyHold || {};
    const r = RESEARCH && RESEARCH.timeframes[state.tf];
    const pc = r && r.chosen[state.venue] && r.chosen[state.venue].perCoin.find((x) => x.symbol === state.coin);
    const stat = (k, val, sub, cls) => `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${val}</div><div class="s">${sub}</div></div>`;
    $('#record').innerHTML = `
      <h3>Tested track record</h3>
      <div class="sub">${c.ticker} · ${Dt.INTERVALS[state.tf].label} · ${venueName(state.venue)} · ${monthYear(a.holdoutStart)} → now · after fees</div>
      <div class="stats">
        ${stat('Model return', pct(h.totalReturn, 0), `Buy &amp; hold ${pct(bh.totalReturn, 0)}`, h.totalReturn >= 0 ? 'up' : 'down')}
        ${stat('Sharpe ratio', num(h.sharpe), `Buy &amp; hold ${num(bh.sharpe)}`)}
        ${stat('Worst drawdown', pct(h.maxDD, 0), `Buy &amp; hold ${pct(bh.maxDD, 0)}`)}
        ${stat('Win rate', pctAbs(h.winRate), `${h.trades.toLocaleString('en-US')} trades`)}
      </div>
      ${pc ? `<div class="spark">${sparkSvg(pc.equity, pc.buyHoldEquity)}</div>
        <div class="spark-legend"><span><i style="background:linear-gradient(90deg,#22d3ee,#c084fc)"></i>Model</span><span><i style="background:#6f7890"></i>Buy &amp; hold</span></div>` : ''}
      <a class="link" href="performance.html#${state.tf}">Full test results →</a>`;
  }

  function renderForecast(a, v, c) {
    const f = a.feat;
    const N = Math.min(90, f.n - F.WARMUP), from = f.n - N;
    const candles = [], probs = [], positions = [];
    for (let i = from; i < f.n; i++) {
      candles.push([f.t[i], f.open[i], f.high[i], f.low[i], f.close[i]]);
      probs.push(v.probs[i] === v.probs[i] ? v.probs[i] : null);
      positions.push(v.positions[i]);
    }
    $('#fc-sub').textContent = `${c.ticker} · next ${horizonText(state.tf, v.H)} · ${Dt.INTERVALS[state.tf].label} candles · history shown is out-of-sample`;
    K.forecastChart.update($('#forecast-chart'), {
      candles, probs, positions, cone: v.cone, tau: v.tau,
      fmt: fmtPrice,
      timeLabel: (t, full) => timeFmt(t, state.tf, full),
      horizonLabel: horizonText(state.tf, v.H),
      positionLabel: (p) => (p > 0 ? (v.longShort ? 'long' : 'in (long)') : p < 0 ? 'short' : v.longShort ? 'flat' : 'out (cash)'),
      aria: `${c.name} recent candles with forecast range for the next ${horizonText(state.tf, v.H)}`,
    });
  }

  // ---------------- actions ----------------
  function setCoin(symbol) {
    if (symbol === state.coin) return;
    state.coin = symbol;
    writeHash();
    renderWatchlist();
    renderHeader();
    mountTv();
    refreshSelected();
  }
  function setTf(tf) {
    if (tf === state.tf) return;
    state.tf = tf;
    writeHash();
    renderControls();
    renderWatchlist();
    mountTv();
    refreshSelected();
    refreshWatchlist();
  }
  function setVenue(venue) {
    if (venue === state.venue) return;
    state.venue = venue;
    writeHash();
    renderControls();
    renderWatchlist();
    const a = state.analyses.get(key(state.coin, state.tf));
    if (a && Dt.INTERVALS[state.tf].model) renderPanels(a);
  }

  $('#tf-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-tf]'); if (b) setTf(b.dataset.tf); });
  $('#venue-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-venue]'); if (b) setVenue(b.dataset.venue); });
  $('#watchlist').addEventListener('click', (e) => { const b = e.target.closest('.wrow'); if (b) setCoin(b.dataset.symbol); });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto-tf]');
    if (g) setTf(g.dataset.gotoTf);
    if (e.target.closest('[data-retry]')) refreshSelected(true);
  });
  window.addEventListener('hashchange', () => {
    const prev = { ...state };
    parseHash();
    if (prev.coin !== state.coin || prev.tf !== state.tf || prev.venue !== state.venue) {
      renderControls();
      renderWatchlist();
      renderHeader();
      mountTv();
      refreshSelected();
      refreshWatchlist();
    }
  });

  function loadTickers() {
    return Dt.tickers(COINS.map((c) => c.symbol)).then((t) => {
      Object.assign(state.tickers, t);
      renderWatchlist();
      renderHeader();
    }).catch(() => {});
  }

  // Countdown + automatic refresh when a new candle closes.
  setInterval(() => {
    const k = key(state.coin, state.tf);
    const a = state.analyses.get(k);
    const cd = $('#countdown');
    if (a && !a.error && cd) {
      const ms = a.nextCloseAt - Date.now();
      cd.textContent = ms > 0 ? durationText(ms) : 'updating…';
    }
    if (a && Dt.INTERVALS[state.tf].model && Date.now() > a.nextCloseAt + 6000 && !state.pending.has(k)) {
      refreshSelected(true);
      refreshWatchlist();
    }
  }, 1000);
  setInterval(() => { if (!state.live) loadTickers(); }, 30000);

  // ---------------- init ----------------
  parseHash();
  writeHash();
  renderControls();
  renderWatchlist();
  renderHeader();
  mountTv();
  loadTickers();
  Dt.liveTickers(COINS.map((c) => c.symbol), onTick, (on) => {
    state.live = on;
    $('#live').classList.toggle('on', on);
  });
  refreshSelected().then(refreshWatchlist);
})();
