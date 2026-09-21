/*
 * Live inference for the hybrid signal: fetch candles, rebuild the exact
 * sub-signals the tuner used, apply the tuned weights / bars / calibration
 * from config/signal.js. derive() then layers the (untested) news tilt and
 * any parameter overrides on top and produces everything the panels display.
 */
(function (root) {
  'use strict';
  const K = root.KAIROS;
  const F = K.features, M = K.model, Sg = K.signal, Dt = K.data;
  const NS = Sg.NS;
  const btcCache = new Map(), htfCache = new Map();
  let fngCache = null;

  function configFor(tf) {
    const C = root.SIGNAL_CONFIG;
    const t = C && C.timeframes && C.timeframes[tf];
    return t && t.config && t.config.weights && t.config.weights.length === NS && t.config.combos && t.config.base ? t : null;
  }

  function typedModel(m) {
    if (!m.__typed) m.__typed = { beta: Float64Array.from(m.beta), mean: Float64Array.from(m.mean), std: Float64Array.from(m.std) };
    return m.__typed;
  }

  function mlProbs(feat, model) {
    const p = new Float32Array(feat.n).fill(NaN), tm = typedModel(model);
    for (let i = 0; i < feat.n; i++) if (feat.valid[i]) p[i] = M.predictRow(tm, feat.X, i * F.D);
    return p;
  }

  async function getJson(url, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Fear & Greed: live from alternative.me, else the local server proxy, else the downloaded history.
  function fngValues() {
    if (fngCache && Date.now() - fngCache.at < 600000) return fngCache.promise;
    const promise = (async () => {
      const parse = (j) => j.data.map((d) => [+d.timestamp * 1000, +d.value]).sort((a, b) => a[0] - b[0]);
      try { return { values: parse(await getJson('https://api.alternative.me/fng/?limit=45&format=json')), source: 'live' }; } catch (e) { /* CORS or offline */ }
      try { return { values: parse(await getJson('api/fng?limit=45')), source: 'live' }; } catch (e) { /* no server */ }
      try { return { values: (await getJson('data/fng.json')).values.slice(-45), source: 'file' }; } catch (e) { return { values: null, source: 'none' }; }
    })();
    fngCache = { at: Date.now(), promise };
    promise.catch(() => { fngCache = null; });
    return promise;
  }

  function btcContext(tf) {
    const hit = btcCache.get(tf);
    if (hit && Date.now() - hit.at < 45000) return hit.promise;
    const promise = (async () => {
      const [k, rates] = await Promise.all([Dt.klines('BTCUSDT', tf, 1000), Dt.funding('BTCUSDT', 100)]);
      const series = F.toSeries(k.closed);
      const feat = F.compute(k.closed, F.TIMEFRAMES[tf], null, rates);
      return { klines: k, rates, series, feat, ctx: Object.assign({ t: series.t, n: series.n }, Sg.logStats(series.close)) };
    })();
    btcCache.set(tf, { at: Date.now(), promise });
    promise.catch(() => btcCache.delete(tf));
    return promise;
  }

  // Daily-chart context for intraday timeframes (closed 1D candles only).
  function htfContext(symbol) {
    const hit = htfCache.get(symbol);
    if (hit && Date.now() - hit.at < 600000) return hit.promise;
    const promise = Dt.klines(symbol, '1d', 400).then((k) => Sg.htfContext(k.closed));
    htfCache.set(symbol, { at: Date.now(), promise });
    promise.catch(() => htfCache.delete(symbol));
    return promise;
  }

  async function analyze(symbol, tf) {
    const cfg = configFor(tf);
    if (!cfg) return null;
    const tfDef = F.TIMEFRAMES[tf], barMs = tfDef.barMs;
    const [btc, fng, htf] = await Promise.all([btcContext(tf), fngValues(), tf === '1d' ? null : htfContext(symbol)]);
    let kl, rates, series, feat, ctx = null;
    if (symbol === 'BTCUSDT') {
      ({ klines: kl, rates, series, feat } = btc);
    } else {
      [kl, rates] = await Promise.all([Dt.klines(symbol, tf, 1000), Dt.funding(symbol, 100)]);
      series = F.toSeries(kl.closed);
      feat = F.compute(kl.closed, tfDef, btc.feat, rates);
      ctx = btc.ctx;
    }
    const ml = mlProbs(feat, cfg.mlModel);
    const sig = Sg.compute(series, ml, ctx, rates, barMs, { fng: fng.values, htf });
    const last = series.n - 1;
    if (!sig.valid[last]) throw new Error('Not enough price history for this coin yet');

    const c = cfg.config, w = Float64Array.from(c.weights);
    const S = sig.S.slice(last * NS, (last + 1) * NS);
    // Per-bar tested scores for the last 300 closed candles (used by the forward-test logger).
    const bars = [];
    for (let i = Math.max(0, last - 299); i <= last; i++) {
      if (!sig.valid[i]) continue;
      bars.push({ i, t: series.t[i], close: series.close[i], score: Sg.composite(sig.S, i * NS, w), atr: sig.atr[i], atrPos: sig.atrPos[i], support: sig.support[i], resistance: sig.resistance[i] });
    }
    return {
      symbol, tf, barMs, t: series.t[last], close: series.close[last], forming: kl.forming,
      atr: sig.atr[last], support: sig.support[last], resistance: sig.resistance[last], atrPos: sig.atrPos[last], rsi: sig.rsi[last],
      fng: sig.fng[last], fngSource: fng.source, fomcHours: K.calendar.untilFomc(Date.now()) / 3600000, htfAlign: sig.htfAlign[last],
      S, scoreTested: Sg.composite(S, 0, w), maxScore: c.maxScore, theta: c.theta, ml: ml[last], bars,
      series: { n: series.n, t: series.t, high: series.high, low: series.low, close: series.close },
      nextCloseAt: series.t[last] + 2 * barMs, cfg, computedAt: Date.now(),
    };
  }

  // Tested score + news tilt (+ your parameter overrides) -> call, exit setup,
  // probability, suggested risk and the breakdown shown in the panels.
  //   params: { theta: [long, short] | null, exit: 'adaptive' | 'fixed', combo: key, showCalls: bool }
  function derive(a, tilt, params) {
    const c = a.cfg.config, w = Float64Array.from(c.weights);
    params = params || {};
    const theta = Array.isArray(params.theta) && params.theta.every(Number.isFinite) ? params.theta : c.theta;
    tilt = Number.isFinite(tilt) ? tilt : 0;
    const score = a.scoreTested + tilt;
    const rawCall = Sg.decide(score, theta), lean = score >= 0 ? 1 : -1, dir = rawCall || lean;
    const gated = c.edge === 'none' && !params.showCalls;
    const call = gated ? 0 : rawCall;
    const cell = Sg.cellOf(a.atrPos, dir, score, theta, c.maxScore);
    let combo, exitReason, exitMode;
    if (params.exit === 'fixed' && c.combos[params.combo]) {
      combo = c.combos[params.combo];
      exitMode = 'override';
      exitReason = 'your fixed setup';
    } else if (c.adaptive && c.policy && c.policy[cell] && !c.policy[cell].fallback) {
      combo = c.combos[c.policy[cell].key];
      exitMode = 'adaptive';
      exitReason = Sg.cellLabel(cell);
    } else {
      combo = c.combos[c.base.key];
      exitMode = 'base';
      exitReason = c.adaptive ? `${Sg.cellLabel(cell)} · too few past trades, base setup` : 'tested base setup';
    }
    const p = Sg.probability(score, dir, combo.cal), base = Sg.probability(0, dir, combo.cal);
    const b = combo.rr || combo.avgWinR || 1;
    const risk = Sg.kellyRisk(p, b, c.kellyCap || 0.02);
    const dirTested = a.scoreTested >= 0 ? 1 : -1;
    const pTested = Sg.probability(a.scoreTested, dirTested, combo.cal);
    const groups = Sg.groupScores(a.S, 0, w);
    const lift = p - base, share = (x) => (Math.abs(score) > 1e-9 ? (lift * x) / score : 0);
    const groupRows = Sg.GROUPS.map((g, gi) => ({ id: g.id, label: g.label, desc: g.desc, score: groups[gi], points: share(groups[gi]) }));
    if (tilt) groupRows.push({ id: 'tilt', label: 'News tilt', desc: 'Live headlines plus your event bias. Not part of the tested formula.', score: tilt, points: share(tilt), untested: true });
    const subs = Sg.SIGNALS.map((s, k) => ({ id: s.id, label: s.label, group: s.group, desc: s.desc, value: a.S[k], weight: w[k], product: w[k] * a.S[k] }));
    return { score, call, rawCall, gated, lean, dir, theta, p, base, pTested, callTested: Sg.decide(a.scoreTested, theta), tilt, groups: groupRows, subs, cell, combo, exitMode, exitReason, risk, b, edge: c.edge };
  }

  K.signalEngine = { analyze, derive, configFor };
})(typeof self !== 'undefined' ? self : this);
