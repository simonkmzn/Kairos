/*
 * Forward test: logs every call the tested formula makes at candle close
 * (all coins, 1H / 4H / 1D, one position per coin and timeframe at a time,
 * the same exit rules as the backtest) and scores it against the candles
 * that follow. Only candles that closed after the engine was last tuned
 * count, so nothing in the log was ever peeked at.
 *
 * Stored in results/forward.json through the local server when it is running,
 * mirrored in this browser's localStorage otherwise.
 */
(function (root) {
  'use strict';
  const K = root.KAIROS;
  const Sg = K.signal, Dt = K.data, F = K.features;
  const TFS = ['1h', '4h', '1d'];
  const KEY = 'terminal.forward';
  const FEE = 0.0007;
  const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
  const state = { trades: [], startedAt: null, loaded: false, server: false, lastSweep: {}, lastSweepAt: null, sweeping: false, error: null, bench: {}, runs: [], logger: null };

  // ---------------- storage ----------------
  function mergeTrades(a, b) {
    const map = new Map();
    for (const t of a) map.set(t.id, t);
    for (const t of b) {
      const cur = map.get(t.id);
      if (!cur || (cur.status === 'open' && t.status === 'closed') || (t.updatedAt || 0) > (cur.updatedAt || 0)) map.set(t.id, t);
    }
    return [...map.values()].sort((x, y) => x.t - y.t);
  }
  async function load() {
    let local = null, remote = null;
    try { local = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* blocked */ }
    try {
      const r = await fetch('results/forward.json', { cache: 'no-store' });
      state.server = true;
      if (r.ok) remote = await r.json();
    } catch (e) {
      state.server = false;
    }
    const a = (local && local.trades) || [], b = (remote && remote.trades) || [];
    state.trades = mergeTrades(a, b);
    state.bench = (remote && remote.bench) || (local && local.bench) || {};
    await loadLoggerStatus();
    state.startedAt = Math.min(local && local.startedAt ? local.startedAt : Infinity, remote && remote.startedAt ? remote.startedAt : Infinity);
    if (!Number.isFinite(state.startedAt)) state.startedAt = Date.now();
    state.loaded = true;
    return state;
  }
  // Written by the unattended logger (tools/logger.ps1) after each of its sweeps.
  async function loadLoggerStatus() {
    try {
      const r = await fetch('results/logger-status.json', { cache: 'no-store' });
      state.logger = r.ok ? await r.json() : null;
    } catch (e) {
      state.logger = null;
    }
    try {
      const r = await fetch('results/logger-runs.json', { cache: 'no-store' });
      state.runs = r.ok ? (await r.json()).runs || [] : [];
    } catch (e) {
      state.runs = [];
    }
  }
  async function reportStatus(error) {
    const status = { at: Date.now(), trades: state.trades.length, open: state.trades.filter((t) => t.status === 'open').length, closed: state.trades.filter((t) => t.status === 'closed').length, error: error || state.error || null };
    try { await fetch('api/save?path=results/logger-status.json', { method: 'POST', body: JSON.stringify(status), headers: { 'Content-Type': 'application/json' } }); } catch (e) { /* no server */ }
    state.logger = status;
    return status;
  }
  async function save() {
    const data = { version: 1, startedAt: state.startedAt, savedAt: Date.now(), bench: state.bench, trades: state.trades };
    const json = JSON.stringify(data);
    try { localStorage.setItem(KEY, json); } catch (e) { /* blocked */ }
    if (!state.server) return;
    try {
      const r = await fetch('api/save?path=results/forward.json', { method: 'POST', body: json, headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      state.server = false;
    }
  }

  // ---------------- scoring (mirrors tuner.outcomes) ----------------
  // kind: 1 target, -1 stop, 2 trailed out in profit, 0 time-out.
  function resolveTrade(tr, series, i0) {
    const d = tr.side, slD = tr.slDist, entry = tr.entry, rr = tr.rr, maxBars = tr.maxBars;
    const h = series.high, l = series.low, c = series.close, n = series.n;
    const tp = rr ? entry + d * slD * rr : NaN, fee = (2 * FEE * entry) / slD;
    let stop = entry - d * slD, best = entry, beDone = false;
    const end = Math.min(n - 1, i0 + maxBars);
    for (let j = i0 + 1; j <= end; j++) {
      if (d > 0 ? l[j] <= stop : h[j] >= stop) {
        const r = (d * (stop - entry)) / slD;
        return { status: 'closed', R: r4(r - fee), kind: r > 1e-9 ? 2 : -1, exitT: series.t[j], exit: stop, bars: j - i0, updatedAt: Date.now() };
      }
      if (rr && (d > 0 ? h[j] >= tp : l[j] <= tp)) return { status: 'closed', R: r4(rr - fee), kind: 1, exitT: series.t[j], exit: tp, bars: j - i0, updatedAt: Date.now() };
      const fav = d > 0 ? h[j] : l[j];
      if (d > 0 ? fav > best : fav < best) best = fav;
      if (tr.stopMode === 'trail') {
        const ns = best - d * slD;
        if (d > 0 ? ns > stop : ns < stop) stop = ns;
      }
      if (tr.be && !beDone && d * (best - entry) >= slD) {
        if (d > 0 ? entry > stop : entry < stop) stop = entry;
        beDone = true;
      }
    }
    if (i0 + maxBars <= n - 1) return { status: 'closed', R: r4((d * (c[end] - entry)) / slD - fee), kind: 0, exitT: series.t[end], exit: c[end], bars: maxBars, updatedAt: Date.now() };
    return { status: 'open', unrealized: r4((d * (c[n - 1] - entry)) / slD - fee), stopNow: r4(stop), bars: n - 1 - i0, updatedAt: Date.now() };
  }

  function indexOfTime(t, v) {
    let lo = 0, hi = t.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (t[m] < v) lo = m + 1; else hi = m;
    }
    return lo < t.length && t[lo] === v ? lo : -1;
  }

  // Resolve open trades and log new sequential entries for one coin / timeframe.
  function processCoin(a, cfgWrap, sinceOverride) {
    const c = cfgWrap.config, tf = a.tf, sym = a.symbol, barMs = a.barMs;
    const cfgAt = Date.parse(root.SIGNAL_CONFIG.generatedAt);
    const eligibleFrom = sinceOverride || Math.max(cfgAt, state.startedAt);
    const mine = state.trades.filter((t) => t.symbol === sym && t.tf === tf).sort((x, y) => x.t - y.t);
    let changed = false;
    for (const tr of mine) {
      if (tr.status !== 'open') continue;
      const i0 = indexOfTime(a.series.t, tr.t);
      if (i0 < 0) { if (!tr.stale) { tr.stale = true; changed = true; } continue; }
      const res = resolveTrade(tr, a.series, i0);
      if (res.status === 'closed' || res.unrealized !== tr.unrealized || res.stopNow !== tr.stopNow) {
        Object.assign(tr, res);
        changed = true;
      }
    }
    if (mine.some((t) => t.status === 'open')) return changed;
    let lastExitT = -Infinity, lastEntryT = -Infinity;
    for (const t of mine) {
      if (t.t > lastEntryT) lastEntryT = t.t;
      if (t.status === 'closed' && t.exitT > lastExitT) lastExitT = t.exitT;
    }
    for (const b of a.bars) {
      if (b.t + barMs < eligibleFrom || b.t <= lastEntryT || b.t <= lastExitT) continue;
      const call = Sg.decide(b.score, c.theta);
      if (!call) continue;
      const cell = Sg.cellOf(b.atrPos, call, b.score, c.theta, c.maxScore);
      const key = c.adaptive && c.policy && c.policy[cell] && !c.policy[cell].fallback ? c.policy[cell].key : c.base.key;
      const cb = c.combos[key];
      const lv = Sg.levels(b.close, b.atr, call, cb, { support: b.support, resistance: b.resistance });
      const p = Sg.probability(b.score, call, cb.cal), bb = cb.rr || cb.avgWinR || 1;
      const tr = {
        id: `${sym}|${tf}|${b.t}`, symbol: sym, tf, side: call, t: b.t, entry: b.close, slDist: r4(lv.slDist), stop: r4(lv.stop), target: lv.target === null ? null : r4(lv.target),
        combo: key, stopMode: cb.stopMode, slAtr: cb.slAtr, rr: cb.rr, be: !!cb.be, maxBars: c.maxBars,
        p: r4(p), b: r4(bb), risk: r4(Sg.kellyRisk(p, bb, c.kellyCap || 0.02)), score: r4(b.score), cfgAt: root.SIGNAL_CONFIG.generatedAt, gated: c.edge === 'none',
        status: 'open', loggedAt: Date.now(),
      };
      Object.assign(tr, resolveTrade(tr, a.series, b.i));
      state.trades.push(tr);
      changed = true;
      if (tr.status === 'open') break;
      lastExitT = tr.exitT;
    }
    if (changed) state.trades.sort((x, y) => x.t - y.t);
    return changed;
  }

  /*
   * The honest benchmark. For the same window, same coins and the same exit rules,
   * score a long entry from EVERY resolvable bar — then compare that with the bars
   * the formula actually fired on. If the formula has entry skill its bars beat the
   * rest; if the week was simply a rally, both look identical.
   */
  function accumulateBench(a, cfgWrap, acc, sinceOverride) {
    const c = cfgWrap.config, cb = c.combos[c.base.key];
    const eligibleFrom = sinceOverride || Math.max(Date.parse(root.SIGNAL_CONFIG.generatedAt), state.startedAt);
    for (const b of a.bars) {
      if (b.t < eligibleFrom || b.i + c.maxBars > a.series.n - 1) continue;
      const slDist = Sg.stopDistance(cb.stopMode, cb.slAtr, b.atr, 1, b.close, b.support, b.resistance);
      const res = resolveTrade({ side: 1, slDist, entry: b.close, rr: cb.rr, maxBars: c.maxBars, stopMode: cb.stopMode, be: cb.be }, a.series, b.i);
      if (res.status !== 'closed') continue;
      acc.n++;
      acc.sum += res.R;
      if (res.R > 0) acc.wins++;
      if (Sg.decide(b.score, c.theta) > 0) {
        acc.nFired++;
        acc.sumFired += res.R;
        if (res.R > 0) acc.winsFired++;
      }
    }
  }
  const finishBench = (acc) => ({
    bars: acc.n, avgR: acc.n ? r4(acc.sum / acc.n) : null, winRate: acc.n ? r4(acc.wins / acc.n) : null,
    firedBars: acc.nFired, firedAvgR: acc.nFired ? r4(acc.sumFired / acc.nFired) : null, firedWinRate: acc.nFired ? r4(acc.winsFired / acc.nFired) : null,
    at: Date.now(),
  });

  // Sweep every coin on every timeframe whose latest candle closed since the last sweep.
  async function sweep(force, opts) {
    if (state.sweeping) return false;
    state.sweeping = true;
    state.error = null;
    const now = Date.now();
    let changed = false;
    try {
      for (const tf of TFS) {
        const cfg = K.signalEngine.configFor(tf);
        if (!cfg) continue;
        const barMs = F.TIMEFRAMES[tf].barMs, lastClose = Math.floor(now / barMs) * barMs;
        if (!force && (state.lastSweep[tf] || 0) >= lastClose) continue;
        const acc = { n: 0, sum: 0, wins: 0, nFired: 0, sumFired: 0, winsFired: 0 };
        for (const coin of Dt.COINS) {
          try {
            const a = await K.signalEngine.analyze(coin.symbol, tf);
            if (processCoin(a, cfg, opts && opts.since)) changed = true;
            accumulateBench(a, cfg, acc, opts && opts.since);
          } catch (e) { state.error = `${coin.ticker} ${tf}: ${e.message}`; }
        }
        state.bench[tf] = finishBench(acc);
        state.lastSweep[tf] = lastClose;
        changed = true;
      }
      state.lastSweepAt = Date.now();
    } finally {
      state.sweeping = false;
    }
    if (changed) await save();
    return changed;
  }

  function stats(trades) {
    const closed = trades.filter((t) => t.status === 'closed'), open = trades.filter((t) => t.status === 'open');
    let wins = 0, sum = 0, eq = 1, eqK = 1, s2 = 0;
    for (const t of closed) {
      if (t.R > 0) wins++;
      sum += t.R;
      s2 += t.R * t.R;
      eq *= 1 + 0.01 * t.R;
      eqK *= 1 + (t.risk || 0) * t.R;
    }
    const n = closed.length, avg = n ? sum / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - avg * avg)) : 0;
    let unreal = 0;
    for (const t of open) unreal += t.unrealized || 0;
    return { closed: n, open: open.length, winRate: n ? wins / n : 0, avgR: avg, totalR: sum, tstat: n && sd > 0 ? (avg / sd) * Math.sqrt(n) : 0, return1pct: eq - 1, returnKelly: eqK - 1, unrealizedR: unreal };
  }

  async function clear() {
    state.trades = [];
    state.startedAt = Date.now();
    state.lastSweep = {};
    await save();
  }

  K.forward = { state, load, save, sweep, stats, clear, resolveTrade, reportStatus, loadLoggerStatus, TFS };
})(typeof self !== 'undefined' ? self : this);
