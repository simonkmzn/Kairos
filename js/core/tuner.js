/*
 * Tunes the hybrid signal on history, one timeframe at a time.
 *
 *  1. Walk-forward ML probabilities (weekly retrain) so the ML input is
 *     out-of-sample on every bar, plus a production model for live use.
 *  2. Sub-signals for every bar of every coin, and the outcome of a trade
 *     entered at every bar in both directions for every exit setup (fixed
 *     ATR stops with or without a move to breakeven, swing-level stops,
 *     trailing stops; targets 1:2 … 1:4 or none; time-out), fees included.
 *     Results in R (multiples of the initial stop distance).
 *  3. FIT half of the train period: for each exit setup start from equal
 *     weights and greedily adjust one weight at a time (+step, -step, zero,
 *     flip); separate long and short bars. VALIDATION half: every setup's
 *     tuned weights are judged against plain equal weights; the best
 *     out-of-sample variant wins and is refitted on the whole train period.
 *  4. Exit policy: per situation (volatility regime × direction × strength)
 *     the exit setup with the best lower-confidence-bound R on the fit half;
 *     kept only if it beats the fixed setup on the validation half.
 *  5. Probability calibration P(trade works | score) per exit setup, on TRAIN.
 *  6. Everything is then measured on HOLDOUT, which took no part in any
 *     choice, including the most recent slice on its own and at maker fees.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const F = K.features, M = K.model, B = K.backtest, Sg = K.signal;
  const NS = Sg.NS, DAY = 86400000;
  const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
  const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
  const r6 = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0);
  const round = (o) => {
    const out = {};
    for (const k in o) out[k] = typeof o[k] === 'number' ? r4(o[k]) : o[k];
    return out;
  };

  const SETTINGS = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    mlSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT'],
    trainStart: '2021-01-01',
    validationStart: '2023-01-01',
    holdoutStart: '2024-07-01',
    recentStart: '2026-01-01',
    feePct: 0.07,
    makerFeePct: 0.04,
    kellyCap: 0.02,
    atrStops: [1.5, 2, 3],
    trailStops: [2, 3],
    rrFixed: [2, 3, 4],
    rrTrail: [3, 4, null],
    thetaGrid: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7],
    step: 0.5,
    fineStep: 0.25,
    maxWeight: 3,
    maxRounds: 10,
    fineRounds: 3,
    minImprove: 0.01,
    minGain: 0.05,
    minTrades: 200,
    minTradeShare: 0.01,
    minCellTrades: 120,
    retrainDays: 7,
    lambdaPerRow: 1e-3,
    timeframes: {
      '1h': { H: 12, maxBars: 48, windowDays: 180 },
      '4h': { H: 6, maxBars: 30, windowDays: 365 },
      '1d': { H: 3, maxBars: 15, windowDays: 730 },
    },
    sampleTrades: 30,
    equityPoints: 300,
  };

  function combosOf() {
    const out = [];
    const add = (stopMode, slAtr, rr, be) => {
      const stopId = stopMode === 'sr' ? 'sr' : stopMode === 'trail' ? `t${slAtr}` : String(slAtr);
      out.push({ key: `${stopId}${be ? 'b' : ''}x${rr || 't'}`, stopId, stopMode, slAtr, rr, be, breakeven: rr ? r4(1 / (1 + rr)) : null });
    };
    for (const k of SETTINGS.atrStops) for (const rr of SETTINGS.rrFixed) { add('atr', k, rr, false); add('atr', k, rr, true); }
    for (const rr of SETTINGS.rrFixed) add('sr', 0, rr, false);
    for (const k of SETTINGS.trailStops) for (const rr of SETTINGS.rrTrail) add('trail', k, rr, false);
    return out;
  }
  const fmtTheta = (th) => (th[0] === th[1] ? `±${th[0]}` : `+${th[0]} / −${th[1]}`);
  const edgeOf = (s) => (s.avgR > 0.05 && s.tstat > 1.5 ? 'edge' : s.avgR > 0 && s.tstat > 0.75 ? 'weak' : 'none');

  // ---------------- walk-forward ML input ----------------
  function walkForward(coins, H, windowDays, barMs, from, endT, say) {
    const W = windowDays * DAY, step = SETTINGS.retrainDays * DAY;
    const bufs = { Z: new Float64Array(0), y: new Uint8Array(0) };
    const probs = coins.map((c) => new Float32Array(c.n).fill(NaN));
    const retrains = [];
    for (let T = from; T <= endT + barMs; T += step) retrains.push(T);
    let beta = null, fits = 0;
    retrains.forEach((T, r) => {
      const set = K.research.trainingSet(coins, T - W, T - (H + 1) * barMs, H, bufs);
      if (!set) return;
      beta = M.fit(set.Z, set.y, set.N, set.P, SETTINGS.lambdaPerRow * set.N, beta, beta ? 3 : 8);
      fits++;
      const model = { beta, mean: set.mean, std: set.std };
      const a0 = T - barMs, a1 = T + step - barMs - 1;
      coins.forEach((co, c) => {
        const i0 = B.lowerBound(co.t, a0), i1 = B.upperBound(co.t, a1) - 1;
        for (let i = i0; i <= i1; i++) if (co.valid[i]) probs[c][i] = M.predictRow(model, co.X, i * F.D);
      });
      if (r % 10 === 0) say(`walk-forward ML input, week ${r + 1}/${retrains.length}`, r / retrains.length);
    });
    const set = K.research.trainingSet(coins, endT - W, endT - H * barMs, H, bufs);
    if (!set) throw new Error('Not enough rows to fit the production ML model');
    const pb = M.fit(set.Z, set.y, set.N, set.P, SETTINGS.lambdaPerRow * set.N, null, 10);
    return {
      probs, fits,
      model: { H, rows: set.N, trainedFrom: new Date(endT - W).toISOString(), trainedThrough: new Date(endT).toISOString(), beta: Array.from(pb, r6), mean: Array.from(set.mean, r6), std: Array.from(set.std, r6) },
    };
  }

  // ---------------- trade outcomes ----------------
  function stopArrays(s, sig, stopMode, k) {
    const n = s.n, L = new Float64Array(n).fill(NaN), Sh = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const a = sig.atr[i];
      if (!(a > 0)) continue;
      L[i] = Sg.stopDistance(stopMode, k, a, 1, s.close[i], sig.support[i], sig.resistance[i]);
      Sh[i] = Sg.stopDistance(stopMode, k, a, -1, s.close[i], sig.support[i], sig.resistance[i]);
    }
    return { L, Sh };
  }

  // For every bar and both directions: R of a trade entered at the close. The stop is
  // checked before the target and before any trailing / breakeven move in the same bar
  // (conservative). kind: 1 target, -1 stop, 2 trailed out in profit, 0 time-out.
  function outcomes(s, slL, slS, cb, maxBars, feePct) {
    const n = s.n, h = s.high, l = s.low, c = s.close;
    const R = new Float32Array(n * 2).fill(NaN), at = new Int32Array(n * 2).fill(-1), kind = new Int8Array(n * 2);
    const trail = cb.stopMode === 'trail', be = !!cb.be, rr = cb.rr;
    for (let i = 0; i < n; i++) {
      if (i + maxBars > n - 1) continue;
      for (let q = 0; q < 2; q++) {
        const d = q === 0 ? 1 : -1, slD = q === 0 ? slL[i] : slS[i];
        if (!(slD > 0)) continue;
        const fee = ((2 * feePct) / 100) * c[i] / slD;
        const entry = c[i], tp = rr ? entry + d * slD * rr : NaN;
        let stop = entry - d * slD, best = entry, beDone = false;
        let r = NaN, j = i + 1, kd = 0;
        for (; j <= i + maxBars; j++) {
          if (d > 0 ? l[j] <= stop : h[j] >= stop) {
            r = (d * (stop - entry)) / slD;
            kd = r > 1e-9 ? 2 : -1;
            break;
          }
          if (rr && (d > 0 ? h[j] >= tp : l[j] <= tp)) { r = rr; kd = 1; break; }
          const fav = d > 0 ? h[j] : l[j];
          if (d > 0 ? fav > best : fav < best) best = fav;
          if (trail) {
            const ns = best - d * slD;
            if (d > 0 ? ns > stop : ns < stop) stop = ns;
          }
          if (be && !beDone && d * (best - entry) >= slD) {
            if (d > 0 ? entry > stop : entry < stop) stop = entry;
            beDone = true;
          }
        }
        if (kd === 0) {
          j = i + maxBars;
          r = (d * (c[j] - entry)) / slD;
        }
        R[i * 2 + q] = r - fee;
        at[i * 2 + q] = j;
        kind[i * 2 + q] = kd;
      }
    }
    return { R, at, kind };
  }

  function buildCoin(sym, data, ml, btcCtx, tfDef, cfgT, extra, combos) {
    const s = F.toSeries(data.candles);
    const sig = Sg.compute(s, ml, sym === 'BTCUSDT' ? null : btcCtx, data.funding, tfDef.barMs, extra);
    const n = s.n, ok = new Uint8Array(n), nextDir = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      ok[i] = sig.valid[i] && ml[i] === ml[i] ? 1 : 0;
      if (i + 1 < n) nextDir[i] = s.close[i + 1] > s.close[i] ? 1 : s.close[i + 1] < s.close[i] ? -1 : 0;
    }
    const stops = {}, feeR = {};
    for (const cb of combos) {
      if (stops[cb.stopId]) continue;
      const sa = stopArrays(s, sig, cb.stopMode, cb.slAtr);
      stops[cb.stopId] = sa;
      const fr = new Float32Array(n * 2).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (sa.L[i] > 0) fr[i * 2] = ((2 * SETTINGS.feePct) / 100) * s.close[i] / sa.L[i];
        if (sa.Sh[i] > 0) fr[i * 2 + 1] = ((2 * SETTINGS.feePct) / 100) * s.close[i] / sa.Sh[i];
      }
      feeR[cb.stopId] = fr;
    }
    const out = {};
    for (const cb of combos) {
      const sa = stops[cb.stopId];
      out[cb.key] = outcomes(s, sa.L, sa.Sh, cb, cfgT.maxBars, SETTINGS.feePct);
    }
    return { symbol: sym, n, t: s.t, close: s.close, S: sig.S, ok, nextDir, atr: sig.atr, atrPos: sig.atrPos, stops, feeR, out };
  }

  // Rows usable for evaluation in [t0, t1]: sub-signals valid, ML available, outcome resolved.
  // tag = 1 for rows at or after splitT (validation half), else 0.
  function flatten(coins, t0, t1, combos, splitT) {
    const k0 = combos[0].key;
    const usable = (co, i) => co.ok[i] && co.out[k0].R[i * 2] === co.out[k0].R[i * 2];
    let N = 0;
    const spans = coins.map((co) => {
      const i0 = B.lowerBound(co.t, t0), i1 = B.upperBound(co.t, t1) - 1;
      for (let i = i0; i <= i1; i++) if (usable(co, i)) N++;
      return [i0, i1];
    });
    const S = new Float32Array(N * NS), nextDir = new Int8Array(N), atrPos = new Float32Array(N), tag = new Uint8Array(N), R = {}, feeR = {};
    for (const cb of combos) {
      R[cb.key] = new Float32Array(N * 2);
      if (!feeR[cb.stopId]) feeR[cb.stopId] = new Float32Array(N * 2);
    }
    let row = 0;
    coins.forEach((co, c) => {
      const [i0, i1] = spans[c];
      for (let i = i0; i <= i1; i++) {
        if (!usable(co, i)) continue;
        S.set(co.S.subarray(i * NS, (i + 1) * NS), row * NS);
        nextDir[row] = co.nextDir[i];
        atrPos[row] = co.atrPos[i];
        tag[row] = co.t[i] >= splitT ? 1 : 0;
        for (const cb of combos) {
          R[cb.key][row * 2] = co.out[cb.key].R[i * 2];
          R[cb.key][row * 2 + 1] = co.out[cb.key].R[i * 2 + 1];
        }
        for (const id in feeR) {
          feeR[id][row * 2] = co.feeR[id][i * 2];
          feeR[id][row * 2 + 1] = co.feeR[id][i * 2 + 1];
        }
        row++;
      }
    });
    return { N, S, nextDir, atrPos, tag, R, feeR };
  }
  function maskOf(flat, tagVal) {
    const m = new Uint8Array(flat.N);
    for (let i = 0; i < flat.N; i++) m[i] = flat.tag[i] === tagVal ? 1 : 0;
    return m;
  }

  // ---------------- evaluation ----------------
  // feeAdj (optional): per-row/direction adjustment added to R (e.g. to re-price fees).
  function evaluator(flat, R, mask, feeAdj) {
    const { S, nextDir, N } = flat, comp = new Float64Array(N);
    let rows = 0;
    if (mask) for (let i = 0; i < N; i++) rows += mask[i]; else rows = N;
    // A formula must fire on enough bars to be judged: never fewer than minTrades, never under 1% of bars.
    const minTrades = Math.max(SETTINGS.minTrades, Math.round(SETTINGS.minTradeShare * rows));
    const setWeights = (w) => {
      for (let i = 0; i < N; i++) {
        let c = 0;
        const off = i * NS;
        for (let k = 0; k < NS; k++) c += w[k] * S[off + k];
        comp[i] = c;
      }
    };
    const commit = (k, dv) => {
      for (let i = 0; i < N; i++) comp[i] += dv * S[i * NS + k];
    };
    function metrics(theta, k, dv) {
      const tl = theta[0], ts = theta[1];
      let n = 0, s1 = 0, s2 = 0, wins = 0, sumWin = 0, correct = 0, allN = 0, allC = 0, longs = 0;
      for (let i = 0; i < N; i++) {
        if (mask && !mask[i]) continue;
        let c = comp[i];
        if (k >= 0) c += dv * S[i * NS + k];
        if (c > 1e-9 || c < -1e-9) {
          allN++;
          if ((c > 0 ? 1 : -1) === nextDir[i]) allC++;
        }
        const d = c > tl ? 1 : c < -ts ? -1 : 0;
        if (!d) continue;
        const q = i * 2 + (d > 0 ? 0 : 1);
        let r = R[q];
        if (feeAdj) r += feeAdj[q];
        n++;
        s1 += r;
        s2 += r * r;
        if (r > 0) { wins++; sumWin += r; }
        if (d > 0) longs++;
        if (d === nextDir[i]) correct++;
      }
      const mean = n ? s1 / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0;
      const tstat = n && sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
      return {
        trades: n, avgR: mean, sdR: sd, tstat, winRate: n ? wins / n : 0, avgWinR: wins ? sumWin / wins : 0, accuracy: n ? correct / n : 0,
        allAccuracy: allN ? allC / allN : 0, share: rows ? n / rows : 0, longShare: n ? longs / n : 0,
        objective: n >= minTrades ? tstat : -1e9,
      };
    }
    // Symmetric bar first, then let the short and long bars move independently.
    function bestTheta() {
      let best = null;
      for (const th of SETTINGS.thetaGrid) {
        const m = metrics([th, th], -1, 0);
        if (!best || m.objective > best.m.objective) best = { theta: [th, th], m };
      }
      for (const side of [1, 0]) {
        for (const th of SETTINGS.thetaGrid) {
          const t2 = best.theta.slice();
          t2[side] = th;
          const m = metrics(t2, -1, 0);
          if (m.objective > best.m.objective + SETTINGS.minGain) best = { theta: t2, m };
        }
      }
      return best;
    }
    return { setWeights, commit, metrics, bestTheta, rows, minTrades };
  }

  const summary = (m) => ({ objective: r4(m.objective), tstat: r4(m.tstat), trades: m.trades, winRate: r4(m.winRate), avgR: r4(m.avgR), avgWinR: r4(m.avgWinR), accuracy: r4(m.accuracy), allAccuracy: r4(m.allAccuracy), share: r4(m.share), longShare: r4(m.longShare) });

  // ---------------- greedy weight search ----------------
  function tune(ev, say, label) {
    const w = new Float64Array(NS).fill(1);
    ev.setWeights(w);
    let { theta, m } = ev.bestTheta();
    let best = m.objective;
    const rounds = [{ round: 0, pass: 'start', theta: fmtTheta(theta), ...summary(m), changes: [] }];

    const pass = (step, maxRounds, tag) => {
      for (let r = 1; r <= maxRounds; r++) {
        const start = best, changes = [];
        for (let k = 0; k < NS; k++) {
          const cur = w[k];
          const cands = [cur - step, cur + step, 0, -cur].filter((v, i, arr) => Math.abs(v) <= SETTINGS.maxWeight + 1e-9 && Math.abs(v - cur) > 1e-9 && arr.indexOf(v) === i);
          let bv = cur, bo = best;
          for (const v of cands) {
            const mm = ev.metrics(theta, k, v - cur);
            if (mm.objective > bo + SETTINGS.minGain) { bo = mm.objective; bv = v; }
          }
          if (bv !== cur) {
            changes.push({ signal: Sg.SIGNALS[k].id, from: cur, to: bv, gain: r4(bo - best) });
            ev.commit(k, bv - cur);
            w[k] = bv;
            best = bo;
          }
        }
        const bt = ev.bestTheta();
        if (bt.m.objective > best + SETTINGS.minGain) {
          changes.push({ signal: 'bar', from: fmtTheta(theta), to: fmtTheta(bt.theta), gain: r4(bt.m.objective - best) });
          theta = bt.theta;
          best = bt.m.objective;
        }
        const mm = ev.metrics(theta, -1, 0);
        rounds.push({ round: rounds.length, pass: tag, theta: fmtTheta(theta), ...summary(mm), changes });
        say(`${label}: ${tag} round ${r}, objective ${best.toFixed(2)}, ${mm.trades} trades, win ${(mm.winRate * 100).toFixed(1)}%, ${changes.length} changes`);
        if (!changes.length || best - start < Math.max(SETTINGS.minImprove * Math.abs(start), 0.02)) break;
      }
    };
    pass(SETTINGS.step, SETTINGS.maxRounds, 'coarse');
    pass(SETTINGS.fineStep, SETTINGS.fineRounds, 'fine');

    const pruned = [];
    for (let k = 0; k < NS; k++) {
      if (w[k] === 0) continue;
      const mm = ev.metrics(theta, k, -w[k]);
      if (mm.objective >= best - 0.01 * Math.abs(best)) {
        pruned.push(Sg.SIGNALS[k].id);
        ev.commit(k, -w[k]);
        w[k] = 0;
        best = mm.objective;
      }
    }
    const importance = Sg.SIGNALS.map((s, k) => ({ id: s.id, label: s.label, group: s.group, weight: w[k], loss: w[k] !== 0 ? r4(best - ev.metrics(theta, k, -w[k]).objective) : 0 }));
    return { w, theta, best, rounds, pruned, importance, final: ev.metrics(theta, -1, 0) };
  }

  // ---------------- exit policy ----------------
  function learnPolicy(flat, mask, w, theta, maxScore, combos, baseKey) {
    const { S, atrPos, N } = flat, stats = new Map();
    for (let i = 0; i < N; i++) {
      if (mask && !mask[i]) continue;
      const c = Sg.composite(S, i * NS, w), d = Sg.decide(c, theta);
      if (!d) continue;
      const cell = Sg.cellOf(atrPos[i], d, c, theta, maxScore), q = d > 0 ? 0 : 1;
      let m = stats.get(cell);
      if (!m) { m = {}; stats.set(cell, m); }
      for (const cb of combos) {
        const r = flat.R[cb.key][i * 2 + q];
        const a = m[cb.key] || (m[cb.key] = [0, 0, 0]);
        a[0]++;
        a[1] += r;
        a[2] += r * r;
      }
    }
    const cells = {};
    for (const [cell, m] of stats) {
      let best = null;
      const table = {};
      for (const cb of combos) {
        const [n, s1, s2] = m[cb.key];
        const mean = n ? s1 / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0, lcb = n ? mean - sd / Math.sqrt(n) : -Infinity;
        table[cb.key] = { n, avgR: r4(mean), lcb: r4(lcb) };
        if (n >= SETTINGS.minCellTrades && (!best || lcb > best.lcb)) best = { key: cb.key, n, mean, lcb };
      }
      cells[cell] = best
        ? { key: best.key, n: best.n, avgR: r4(best.mean), lcb: r4(best.lcb), fallback: false, baseAvgR: table[baseKey].avgR }
        : { key: baseKey, n: m[baseKey][0], avgR: table[baseKey].avgR, lcb: table[baseKey].lcb, fallback: true, baseAvgR: table[baseKey].avgR };
    }
    return cells;
  }

  function policyMetrics(flat, mask, w, theta, maxScore, cells, baseKey, minTrades) {
    const { S, nextDir, atrPos, N } = flat, tl = theta[0], ts = theta[1];
    let n = 0, s1 = 0, s2 = 0, wins = 0, sumWin = 0, correct = 0, allN = 0, allC = 0, longs = 0, rows = 0;
    for (let i = 0; i < N; i++) {
      if (mask && !mask[i]) continue;
      rows++;
      const c = Sg.composite(S, i * NS, w);
      if (c > 1e-9 || c < -1e-9) {
        allN++;
        if ((c > 0 ? 1 : -1) === nextDir[i]) allC++;
      }
      const d = c > tl ? 1 : c < -ts ? -1 : 0;
      if (!d) continue;
      const cell = Sg.cellOf(atrPos[i], d, c, theta, maxScore);
      const key = cells[cell] ? cells[cell].key : baseKey;
      const r = flat.R[key][i * 2 + (d > 0 ? 0 : 1)];
      n++;
      s1 += r;
      s2 += r * r;
      if (r > 0) { wins++; sumWin += r; }
      if (d > 0) longs++;
      if (d === nextDir[i]) correct++;
    }
    const mean = n ? s1 / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0;
    const tstat = n && sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
    return { trades: n, avgR: mean, sdR: sd, tstat, winRate: n ? wins / n : 0, avgWinR: wins ? sumWin / wins : 0, accuracy: n ? correct / n : 0, allAccuracy: allN ? allC / allN : 0, share: rows ? n / rows : 0, longShare: n ? longs / n : 0, objective: n >= minTrades ? tstat : -1e9 };
  }

  // ---------------- calibration ----------------
  function calibrate(flat, R, w, mask) {
    const { S, N } = flat;
    const out = {};
    for (const [key, d] of [['long', 1], ['short', -1]]) {
      const xs = [], ys = [];
      for (let i = 0; i < N; i++) {
        if (mask && !mask[i]) continue;
        const c = Sg.composite(S, i * NS, w);
        if (d > 0 ? c > 0 : c < 0) {
          xs.push(Math.abs(c));
          ys.push(R[i * 2 + (d > 0 ? 0 : 1)] > 0 ? 1 : 0);
        }
      }
      const n = xs.length;
      if (n < 50) { out[key] = [0, 0]; continue; }
      const Z = new Float64Array(n * 2), y = Uint8Array.from(ys);
      for (let i = 0; i < n; i++) { Z[i * 2] = 1; Z[i * 2 + 1] = xs[i]; }
      const beta = M.fit(Z, y, n, 2, 1, null, 30);
      out[key] = [r4(beta[0]), r4(beta[1])];
    }
    return out;
  }

  // ---------------- sequential simulation (one position per coin at a time) ----------------
  // chooser(cell) -> combo (with .cal and .avgWinR)
  function sequential(co, w, theta, maxScore, chooser, t0, t1) {
    const { S, ok, t, close, n, nextDir } = co;
    const i1 = B.upperBound(t, t1) - 1;
    const trades = [];
    let i = B.lowerBound(t, t0);
    while (i <= i1 && i < n) {
      if (!ok[i]) { i++; continue; }
      const c = Sg.composite(S, i * NS, w), d = Sg.decide(c, theta);
      if (!d) { i++; continue; }
      const cell = Sg.cellOf(co.atrPos[i], d, c, theta, maxScore), cb = chooser(cell);
      const o = co.out[cb.key], idx = i * 2 + (d > 0 ? 0 : 1), r = o.R[idx];
      if (!(r === r)) { i++; continue; }
      const at = o.at[idx], kind = o.kind[idx];
      const slD = (d > 0 ? co.stops[cb.stopId].L : co.stops[cb.stopId].Sh)[i];
      const stop = close[i] - d * slD, target = cb.rr ? close[i] + d * slD * cb.rr : null;
      const p = Sg.probability(c, d, cb.cal), b = cb.rr || cb.avgWinR || 1;
      trades.push({
        symbol: co.symbol, side: d, t: t[i], exitT: t[at], entry: close[i], stop, target,
        exit: kind === 1 ? target : kind === -1 ? stop : close[i] + d * slD * (r + o.R[idx] - r), R: r, bars: at - i, kind, combo: cb.key, cell,
        p: r4(p), b: r4(b), risk: r4(Sg.kellyRisk(p, b, SETTINGS.kellyCap)), score: r4(c), nextOk: d === nextDir[i] ? 1 : 0,
      });
      i = at + 1;
    }
    return trades;
  }

  function tradeStats(trades) {
    let wins = 0, sumWin = 0, sumLoss = 0, cum = 0, peak = 0, maxDD = 0, bars = 0, correct = 0, eq = 1, eqK = 1, riskSum = 0, tp = 0, sl = 0, tr = 0, s2 = 0, longs = 0;
    for (const x of trades) {
      if (x.R > 0) { wins++; sumWin += x.R; } else sumLoss += x.R;
      cum += x.R;
      s2 += x.R * x.R;
      if (cum > peak) peak = cum;
      if (cum - peak < maxDD) maxDD = cum - peak;
      bars += x.bars;
      correct += x.nextOk;
      eq *= 1 + 0.01 * x.R;
      eqK *= 1 + (x.risk || 0) * x.R;
      riskSum += x.risk || 0;
      if (x.kind === 1) tp++; else if (x.kind === -1) sl++; else if (x.kind === 2) tr++;
      if (x.side > 0) longs++;
    }
    const n = trades.length, avg = n ? cum / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - avg * avg)) : 0;
    return round({
      trades: n, winRate: n ? wins / n : 0, avgR: avg, totalR: cum, tstat: n && sd > 0 ? (avg / sd) * Math.sqrt(n) : 0,
      profitFactor: sumLoss < 0 ? Math.min(sumWin / -sumLoss, 99) : sumWin > 0 ? 99 : 0, maxDrawdownR: maxDD,
      accuracy: n ? correct / n : 0, avgBars: n ? bars / n : 0, tpRate: n ? tp / n : 0, slRate: n ? sl / n : 0, trailRate: n ? tr / n : 0, timeoutRate: n ? (n - tp - sl - tr) / n : 0,
      longShare: n ? longs / n : 0, return1pct: eq - 1, returnKelly: eqK - 1, avgRisk: n ? riskSum / n : 0,
    });
  }

  function seqAll(coins, w, theta, maxScore, chooser, t0, t1) {
    const all = [];
    const perCoin = coins.map((co) => {
      const trades = sequential(co, w, theta, maxScore, chooser, t0, t1);
      all.push(...trades);
      return { symbol: co.symbol, stats: tradeStats(trades) };
    });
    all.sort((a, b) => a.t - b.t);
    return { trades: all, stats: tradeStats(all), perCoin };
  }

  function groupBy(trades, keyFn) {
    const g = {};
    for (const tr of trades) (g[keyFn(tr)] || (g[keyFn(tr)] = [])).push(tr);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, tradeStats(v)]));
  }

  function calibrationTable(trades, buckets) {
    const sorted = trades.slice().sort((a, b) => a.p - b.p);
    const out = [];
    let brier = 0;
    for (const tr of trades) brier += (tr.p - (tr.R > 0 ? 1 : 0)) ** 2;
    const size = Math.ceil(sorted.length / buckets);
    for (let b = 0; b < sorted.length; b += size) {
      const chunk = sorted.slice(b, b + size);
      let sp = 0, wins = 0;
      for (const tr of chunk) { sp += tr.p; if (tr.R > 0) wins++; }
      out.push({ predicted: r4(sp / chunk.length), actual: r4(wins / chunk.length), n: chunk.length });
    }
    return { buckets: out, brier: trades.length ? r4(brier / trades.length) : null };
  }

  function equityCurve(trades, maxPts) {
    const sorted = trades.slice().sort((a, b) => a.exitT - b.exitT);
    const pts = [];
    let cum = 0;
    for (const tr of sorted) {
      cum += tr.R;
      pts.push({ t: tr.exitT, R: r4(cum) });
    }
    const step = Math.max(1, Math.ceil(pts.length / maxPts));
    const out = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
    if ((pts.length - 1) % step) out.push(pts[pts.length - 1]);
    return out;
  }

  // ---------------- pipeline ----------------
  function runTimeframe(tf, data, opts, say) {
    const started = Date.now();
    const tfDef = F.TIMEFRAMES[tf], cfgT = SETTINGS.timeframes[tf], barMs = tfDef.barMs;
    const symbols = (opts && opts.symbols) || SETTINGS.symbols;
    const fng = (opts && opts.fng) || null, htfData = tf !== '1d' && opts && opts.htf ? opts.htf : null;
    const combos = combosOf(), byKey = Object.fromEntries(combos.map((cb) => [cb.key, cb]));
    const label = tfDef.label;

    say(`${label}: computing ML features`, 0);
    const mlSyms = SETTINGS.mlSymbols.filter((s) => data[s] && data[s].candles && data[s].candles.length > F.WARMUP + 300);
    const btcFeat = F.compute(data.BTCUSDT.candles, tfDef, null, data.BTCUSDT.funding);
    const feats = mlSyms.map((s) => Object.assign({ symbol: s }, s === 'BTCUSDT' ? btcFeat : F.compute(data[s].candles, tfDef, btcFeat, data[s].funding)));
    const trainStart = ms(SETTINGS.trainStart), holdStart = ms(SETTINGS.holdoutStart), valStart = ms(SETTINGS.validationStart), recentStart = ms(SETTINGS.recentStart);
    const endT = Math.min(...symbols.map((s) => data[s].candles[data[s].candles.length - 1][0]));

    const wf = walkForward(feats, cfgT.H, cfgT.windowDays, barMs, trainStart, endT, (msg, f) => say(`${label}: ${msg}`, f * 0.3));

    say(`${label}: sub-signals and trade outcomes for ${combos.length} exit setups`, 0.32);
    const btcS = F.toSeries(data.BTCUSDT.candles);
    const btcCtx = Object.assign({ t: btcS.t, n: btcS.n }, Sg.logStats(btcS.close));
    const coins = symbols.map((sym) => {
      const htf = htfData && htfData[sym] ? Sg.htfContext(htfData[sym]) : null;
      return buildCoin(sym, data[sym], wf.probs[mlSyms.indexOf(sym)], btcCtx, tfDef, cfgT, { fng, htf }, combos);
    });

    const selTo = holdStart - barMs;
    const train = flatten(coins, trainStart, selTo, combos, valStart), hold = flatten(coins, holdStart, endT, combos, Infinity);
    const fitMask = maskOf(train, 0), valMask = maskOf(train, 1);
    let fitN = 0;
    for (let i = 0; i < train.N; i++) fitN += fitMask[i];
    say(`${label}: ${fitN.toLocaleString()} fit rows, ${(train.N - fitN).toLocaleString()} validation rows, ${hold.N.toLocaleString()} holdout rows`, 0.4);

    // 1. Nested selection of the base exit setup and tuned-vs-equal weights.
    const equal = new Float64Array(NS).fill(1);
    const selection = combos.map((cb, ci) => {
      const evFit = evaluator(train, train.R[cb.key], fitMask);
      const res = tune(evFit, (msg) => say(msg, 0.4 + ((ci + 0.5) / combos.length) * 0.38), `${label} ${Sg.comboLabel(cb)}`);
      const evVal = evaluator(train, train.R[cb.key], valMask);
      evVal.setWeights(res.w);
      const valTuned = evVal.metrics(res.theta, -1, 0);
      evFit.setWeights(equal);
      const eqTheta = evFit.bestTheta().theta;
      evVal.setWeights(equal);
      const valEq = evVal.metrics(eqTheta, -1, 0);
      return Object.assign({}, cb, { fitObjective: r4(res.best), tuned: { theta: fmtTheta(res.theta), val: summary(valTuned) }, equal: { theta: fmtTheta(eqTheta), val: summary(valEq) } });
    });
    let pick = null;
    for (const s of selection) for (const variant of ['tuned', 'equal']) {
      const o = s[variant].val.objective;
      if (!pick || o > pick.objective) pick = { key: s.key, variant, objective: o };
    }
    const base = byKey[pick.key];
    selection.forEach((s) => { s.chosen = s.key === base.key ? pick.variant : ''; });

    // 2. Final weights and bars on the whole train period.
    say(`${label}: final fit on the full train period (${pick.variant} weights, ${Sg.comboLabel(base)})`, 0.8);
    const evTrain = evaluator(train, train.R[base.key], null);
    let w, theta, rounds, pruned, importance;
    if (pick.variant === 'tuned') {
      ({ w, theta, rounds, pruned, importance } = tune(evTrain, (msg) => say(msg, 0.82), `${label} final`));
    } else {
      w = Float64Array.from(equal);
      evTrain.setWeights(w);
      const bt = evTrain.bestTheta();
      theta = bt.theta;
      rounds = [{ round: 0, pass: 'start', theta: fmtTheta(theta), ...summary(bt.m), changes: [] }];
      pruned = [];
      importance = Sg.SIGNALS.map((s, k) => ({ id: s.id, label: s.label, group: s.group, weight: 1, loss: r4(bt.m.objective - evTrain.metrics(theta, k, -1).objective) }));
    }
    const maxScore = Sg.maxScore(w);

    // 3. Exit policy: learn on fit, keep only if it beats the fixed setup on validation.
    say(`${label}: learning the exit policy`, 0.86);
    const cellsFit = learnPolicy(train, fitMask, w, theta, maxScore, combos, base.key);
    const evValBase = evaluator(train, train.R[base.key], valMask);
    evValBase.setWeights(w);
    const valFixed = evValBase.metrics(theta, -1, 0);
    const valPolicy = policyMetrics(train, valMask, w, theta, maxScore, cellsFit, base.key, evValBase.minTrades);
    const adaptive = valPolicy.objective > valFixed.objective + SETTINGS.minGain;
    const cells = learnPolicy(train, null, w, theta, maxScore, combos, base.key);
    const policyCheck = { validationFixed: summary(valFixed), validationPolicy: summary(valPolicy), adaptive };

    // 4. Per-setup calibrations and per-bar stats (train + holdout) with the final weights.
    say(`${label}: calibrating every exit setup`, 0.9);
    const comboInfo = {};
    for (const cb of combos) {
      const evH = evaluator(hold, hold.R[cb.key], null);
      evH.setWeights(w);
      const evT = evaluator(train, train.R[cb.key], null);
      evT.setWeights(w);
      const tm = summary(evT.metrics(theta, -1, 0));
      comboInfo[cb.key] = Object.assign({}, cb, { cal: calibrate(train, train.R[cb.key], w, null), holdout: summary(evH.metrics(theta, -1, 0)), train: tm, avgWinR: tm.avgWinR });
    }
    const evHB = evaluator(hold, hold.R[base.key], null);
    evHB.setWeights(w);
    const thetaTable = SETTINGS.thetaGrid.map((th) => ({ theta: th, ...summary(evHB.metrics([th, th], -1, 0)) }));
    // Fee sensitivity: the same signals and base setup at maker-level fees.
    const feeAdj = new Float32Array(hold.N * 2);
    const fr = hold.feeR[base.stopId], scale = 1 - SETTINGS.makerFeePct / SETTINGS.feePct;
    for (let i = 0; i < feeAdj.length; i++) feeAdj[i] = fr[i] === fr[i] ? fr[i] * scale : 0;
    const evMaker = evaluator(hold, hold.R[base.key], null, feeAdj);
    evMaker.setWeights(w);
    const holdoutMakerFees = summary(evMaker.metrics(theta, -1, 0));

    // 5. Sequential simulations.
    say(`${label}: measuring holdout`, 0.94);
    const chooserFor = (cals, useCells) => (cell) => {
      const key = useCells && cells[cell] ? cells[cell].key : base.key;
      return Object.assign({}, comboInfo[key], { cal: cals ? cals[key] : comboInfo[key].cal });
    };
    const evB = evaluator(train, train.R[base.key], null);
    evB.setWeights(equal);
    const baseTheta = evB.bestTheta().theta;
    const mlW = new Float64Array(NS); mlW[0] = 1;
    const evM = evaluator(train, train.R[base.key], null);
    evM.setWeights(mlW);
    const mlTheta = evM.bestTheta().theta;
    const withCal = (cal) => Object.fromEntries(combos.map((cb) => [cb.key, cal]));
    const configs = [
      { id: 'baseline', label: 'Equal weights (start)', w: equal, theta: baseTheta, chooser: chooserFor(withCal(calibrate(train, train.R[base.key], equal, null)), false), fixed: true },
      { id: 'mlOnly', label: 'ML model only', w: mlW, theta: mlTheta, chooser: chooserFor(withCal(calibrate(train, train.R[base.key], mlW, null)), false), fixed: true },
      { id: 'fixed', label: 'Final weights, fixed exits', w, theta, chooser: chooserFor(null, false), fixed: true },
      { id: 'tuned', label: adaptive ? 'Final formula, adaptive exits' : 'Final formula (fixed exits won validation)', w, theta, chooser: chooserFor(null, adaptive), fixed: !adaptive },
    ];
    const compare = {};
    let finalSeq = null;
    for (const c of configs) {
      const ms2 = Sg.maxScore(c.w);
      const trn = seqAll(coins, c.w, c.theta, ms2, c.chooser, trainStart, selTo);
      const ho = seqAll(coins, c.w, c.theta, ms2, c.chooser, holdStart, endT);
      const pbT = c.fixed ? (() => { const e = evaluator(train, train.R[base.key], null); e.setWeights(c.w); return e.metrics(c.theta, -1, 0); })() : policyMetrics(train, null, c.w, c.theta, ms2, cells, base.key, 0);
      const pbH = c.fixed ? (() => { const e = evaluator(hold, hold.R[base.key], null); e.setWeights(c.w); return e.metrics(c.theta, -1, 0); })() : policyMetrics(hold, null, c.w, c.theta, ms2, cells, base.key, 0);
      compare[c.id] = { label: c.label, theta: fmtTheta(c.theta), train: trn.stats, holdout: ho.stats, holdoutRecent: tradeStats(ho.trades.filter((x) => x.t >= recentStart)), perBarTrain: summary(pbT), perBarHoldout: summary(pbH) };
      if (c.id === 'tuned') finalSeq = { train: trn, holdout: ho };
    }
    const cellTable = Object.keys(cells).sort().map((cell) => ({
      cell, label: Sg.cellLabel(cell), key: cells[cell].key, fallback: cells[cell].fallback, trainTrades: cells[cell].n, trainAvgR: cells[cell].avgR, trainBaseAvgR: cells[cell].baseAvgR,
      holdout: groupBy(finalSeq.holdout.trades, (t) => t.cell)[cell] || null,
    }));
    const calTrain = calibrationTable(finalSeq.train.trades, 5), calHold = calibrationTable(finalSeq.holdout.trades, 5);
    const sample = finalSeq.holdout.trades.slice(-SETTINGS.sampleTrades).reverse();
    const edge = edgeOf(compare.tuned.holdout);

    say(`${label}: done`, 1);
    return {
      timeframe: tf, label, barMs, generatedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started) / 100) / 10,
      symbols, mlSymbols: mlSyms, windows: { trainStart: SETTINGS.trainStart, validationStart: SETTINGS.validationStart, holdoutStart: SETTINGS.holdoutStart, recentStart: SETTINGS.recentStart, end: new Date(endT + barMs).toISOString() },
      rows: { fit: fitN, validation: train.N - fitN, train: train.N, holdout: hold.N }, hasFng: !!fng, hasHtf: !!htfData,
      config: {
        H: cfgT.H, maxBars: cfgT.maxBars, feePct: SETTINGS.feePct, makerFeePct: SETTINGS.makerFeePct, kellyCap: SETTINGS.kellyCap, theta: theta.slice(), weights: Array.from(w, r4), maxScore: r4(maxScore), variant: pick.variant,
        base: { key: base.key, stopId: base.stopId, stopMode: base.stopMode, slAtr: base.slAtr, rr: base.rr, be: base.be, breakeven: base.breakeven },
        adaptive, policy: adaptive ? cells : null, combos: comboInfo, thetaTable, edge,
      },
      selection, policyCheck, cellTable, rounds, pruned, importance,
      compare, holdoutMakerFees,
      perCoin: finalSeq.holdout.perCoin.map((pc, i) => ({ symbol: pc.symbol, holdout: pc.stats, train: finalSeq.train.perCoin[i].stats })),
      calibration: { train: calTrain, holdout: calHold },
      equity: equityCurve(finalSeq.holdout.trades, SETTINGS.equityPoints),
      sampleTrades: sample,
      mlModel: wf.model, mlFits: wf.fits,
    };
  }

  K.tuner = { SETTINGS, runTimeframe, outcomes, tradeStats, combosOf, fmtTheta, edgeOf };
})(typeof self !== 'undefined' ? self : this);
