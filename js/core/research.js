/*
 * Kairos research pipeline (one timeframe at a time).
 *
 *  1. Features for every coin (BTC first, alts get BTC context).
 *  2. Walk-forward: every week, fit one logistic model on all coins pooled over
 *     the trailing window (only rows whose outcome was already known), then
 *     predict the following week. Every prediction is out-of-sample.
 *  3. Variants: horizon H x entry threshold tau x venue (spot long-only, or
 *     perpetual futures long/short with funding). Each venue picks its variant
 *     on the SELECTION period only (2021-01-01 .. 2024-06-30).
 *  4. The chosen variant is then reported on the HOLDOUT period
 *     (2024-07-01 .. latest), with a pre-registered edge rule.
 *  5. A production model is fitted on the most recent window for live use.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const F = K.features, M = K.model, B = K.backtest;

  const SETTINGS = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT'],
    timeframes: {
      '1d': { horizons: [1, 3, 7], windowDays: 730 },
      '4h': { horizons: [3, 6, 12], windowDays: 365 },
      '1h': { horizons: [4, 12, 24], windowDays: 180 },
    },
    oosStart: '2021-01-01',
    holdoutStart: '2024-07-01',
    retrainDays: 7,
    lambdaPerRow: 1e-3,
    maxTrainRows: 60000,
    taus: [0, 0.02, 0.04, 0.06],
    venues: [
      { id: 'spot', label: 'Spot · long only', longShort: false, costPct: 0.15, funding: false },
      { id: 'perp', label: 'Futures 1× · long & short', longShort: true, costPct: 0.07, funding: true },
    ],
    minTradesSelection: 30,
    bootstrapIters: 1000,
    edgeRule: { minSharpe: 0.75, minProbPositive: 0.9, minProfitFactor: 1.1 },
    recentBars: 160,
    equityPoints: 240,
    coinEquityPoints: 120,
    seed: 7,
  };

  const DAY = 86400000;
  const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
  const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
  const r6 = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0);
  const round = (o) => {
    const out = {};
    for (const k in o) out[k] = typeof o[k] === 'number' ? r4(o[k]) : o[k];
    return out;
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function equityCurve(rets, maxPts) {
    const eq = [];
    let e = 1;
    for (let j = 0; j < rets.length; j++) {
      if (rets[j] === rets[j]) e *= 1 + rets[j];
      eq.push(e);
    }
    const step = Math.max(1, Math.ceil(eq.length / maxPts));
    const values = [];
    for (let j = 0; j < eq.length; j += step) values.push(r4(eq[j]));
    if ((eq.length - 1) % step) values.push(r4(eq[eq.length - 1]));
    return { step, values };
  }

  function tradeSummary(trades) {
    let w = 0, sw = 0, sl = 0;
    for (const t of trades) {
      if (t.ret > 0) { w++; sw += t.ret; } else sl += t.ret;
    }
    return { trades: trades.length, winRate: trades.length ? w / trades.length : 0, profitFactor: sl < 0 ? Math.min(sw / -sl, 99) : sw > 0 ? 99 : 0 };
  }

  function verdict(stats, prob) {
    const e = SETTINGS.edgeRule;
    if (stats.sharpe >= e.minSharpe && (prob || 0) >= e.minProbPositive && stats.profitFactor >= e.minProfitFactor) return 'edge';
    if (stats.sharpe > 0 && stats.totalReturn > 0) return 'weak';
    return 'none';
  }

  // Builds the standardized, pooled training matrix for rows with open time in [from, to].
  function trainingSet(coins, from, to, H, bufs) {
    const D = F.D, P = D + 1;
    const ranges = [];
    let count = 0;
    for (let c = 0; c < coins.length; c++) {
      const co = coins[c];
      const a = B.lowerBound(co.t, from);
      const b = Math.min(B.upperBound(co.t, to) - 1, co.n - 1 - H);
      if (b < a) continue;
      ranges.push([c, a, b]);
      for (let i = a; i <= b; i++) count += co.valid[i];
    }
    if (count < 1000) return null;
    const mean = new Float64Array(D), sq = new Float64Array(D);
    for (const [c, a, b] of ranges) {
      const co = coins[c];
      for (let i = a; i <= b; i++) {
        if (!co.valid[i]) continue;
        const off = i * D;
        for (let k = 0; k < D; k++) {
          const v = co.X[off + k];
          mean[k] += v;
          sq[k] += v * v;
        }
      }
    }
    const std = new Float64Array(D);
    for (let k = 0; k < D; k++) {
      mean[k] /= count;
      std[k] = Math.sqrt(Math.max(sq[k] / count - mean[k] * mean[k], 0)) || 1;
      if (std[k] < 1e-9) std[k] = 1;
    }
    const stride = Math.ceil(count / SETTINGS.maxTrainRows);
    const N = Math.ceil(count / stride);
    if (bufs.Z.length < N * P) {
      bufs.Z = new Float64Array(N * P);
      bufs.y = new Uint8Array(N);
    }
    const Z = bufs.Z, y = bufs.y, clip = M.CLIP;
    let row = 0, seen = 0;
    for (const [c, a, b] of ranges) {
      const co = coins[c];
      for (let i = a; i <= b; i++) {
        if (!co.valid[i]) continue;
        if (seen++ % stride !== 0) continue;
        const base = row * P, off = i * D;
        Z[base] = 1;
        for (let k = 0; k < D; k++) {
          let z = (co.X[off + k] - mean[k]) / std[k];
          Z[base + 1 + k] = z > clip ? clip : z < -clip ? -clip : z;
        }
        y[row] = co.lc[i + H] > co.lc[i] ? 1 : 0;
        row++;
      }
    }
    return { Z, y, N: row, P, mean, std };
  }

  function runTimeframe(tfId, data, say) {
    const S = SETTINGS, tf = F.TIMEFRAMES[tfId], cfg = S.timeframes[tfId], barMs = tf.barMs;
    const started = Date.now();
    const rand = mulberry32(S.seed);
    const D = F.D;

    say(`${tf.label}: computing features`, 0);
    const syms = S.symbols.filter((s) => data[s] && data[s].candles && data[s].candles.length > F.WARMUP + 300);
    const btc = F.compute(data.BTCUSDT.candles, tf, null, data.BTCUSDT.funding);
    const coins = syms.map((s) => Object.assign({ symbol: s }, s === 'BTCUSDT' ? btc : F.compute(data[s].candles, tf, btc, data[s].funding)));

    const oosStart = ms(S.oosStart), holdStart = ms(S.holdoutStart);
    const endT = Math.min(...coins.map((c) => c.t[c.n - 1]));
    const W = cfg.windowDays * DAY, step = S.retrainDays * DAY;
    const retrains = [];
    for (let T = oosStart; T <= endT + barMs; T += step) retrains.push(T);

    // ---- walk-forward predictions ----
    const bufs = { Z: new Float64Array(0), y: new Uint8Array(0) };
    const preds = {};
    const trainLog = {};
    cfg.horizons.forEach((H, hi) => {
      const p = coins.map((c) => new Float32Array(c.n).fill(NaN));
      let beta = null, fits = 0, rowsTotal = 0;
      retrains.forEach((T, r) => {
        const set = trainingSet(coins, T - W, T - (H + 1) * barMs, H, bufs);
        if (!set) return;
        beta = M.fit(set.Z, set.y, set.N, set.P, S.lambdaPerRow * set.N, beta, beta ? 3 : 8);
        fits++;
        rowsTotal += set.N;
        const model = { beta, mean: set.mean, std: set.std };
        const from = T - barMs, to = T + step - barMs - 1;
        for (let c = 0; c < coins.length; c++) {
          const co = coins[c];
          const a = B.lowerBound(co.t, from), b = B.upperBound(co.t, to) - 1;
          for (let i = a; i <= b; i++) if (co.valid[i]) p[c][i] = M.predictRow(model, co.X, i * D);
        }
        if (r % 8 === 0) say(`${tf.label}: walk-forward H=${H}, week ${r + 1}/${retrains.length}`, (hi + r / retrains.length) / cfg.horizons.length * 0.75);
      });
      preds[H] = p;
      trainLog[H] = { fits, avgRows: fits ? Math.round(rowsTotal / fits) : 0 };
    });

    // ---- variants ----
    say(`${tf.label}: backtesting variants`, 0.78);
    const selTo = holdStart - barMs;
    const variants = [];
    for (const H of cfg.horizons) for (const venue of S.venues) for (const tau of S.taus) {
      const c = { tau, longShort: venue.longShort, cost: venue.costPct / 100, funding: venue.funding, barMs };
      variants.push({
        H, venue: venue.id, tau,
        selection: round(B.simulate(coins, preds[H], c, oosStart, selTo).stats),
        holdout: round(B.simulate(coins, preds[H], c, holdStart, endT).stats),
      });
    }

    const ones = coins.map((c) => new Float32Array(c.n).fill(1));
    const bhCfg = { tau: 0, longShort: false, cost: S.venues[0].costPct / 100, funding: false, barMs };
    const bhHold = B.simulate(coins, ones, bhCfg, holdStart, endT, true);
    const buyHold = {
      selection: round(B.simulate(coins, ones, bhCfg, oosStart, selTo).stats),
      holdout: round(bhHold.stats),
      equity: equityCurve(bhHold.port, S.equityPoints),
    };
    const block = Math.max(5, Math.round((7 * DAY) / barMs));

    // ---- choose per venue on selection only, report holdout ----
    const chosen = {};
    for (const venue of S.venues) {
      const pool = variants.filter((v) => v.venue === venue.id && v.selection.trades >= S.minTradesSelection);
      const pick = (pool.length ? pool : variants.filter((v) => v.venue === venue.id)).slice().sort((a, b) => b.selection.sharpe - a.selection.sharpe)[0];
      const c = { tau: pick.tau, longShort: venue.longShort, cost: venue.costPct / 100, funding: venue.funding, barMs };
      const hold = B.simulate(coins, preds[pick.H], c, holdStart, endT, true);
      const prob = B.probPositive(hold.port, block, S.bootstrapIters, rand);
      const perCoin = hold.perCoin.map((pc) => {
        const st = Object.assign(B.statsOf(pc.rets, barMs), tradeSummary(pc.trades));
        const bh = bhHold.perCoin.find((x) => x.symbol === pc.symbol);
        const bhSt = bh ? B.statsOf(bh.rets, barMs) : null;
        const pcProb = B.probPositive(pc.rets, block, 400, rand);
        return {
          symbol: pc.symbol, holdout: round(st), probPositive: pcProb === null ? null : r4(pcProb), verdict: verdict(st, pcProb),
          buyHold: bhSt ? round(bhSt) : null,
          equity: equityCurve(pc.rets, S.coinEquityPoints).values,
          buyHoldEquity: bh ? equityCurve(bh.rets, S.coinEquityPoints).values : null,
        };
      });
      chosen[venue.id] = {
        venue: venue.id, label: venue.label, costPct: venue.costPct, funding: venue.funding, longShort: venue.longShort,
        H: pick.H, tau: pick.tau, selection: pick.selection, holdout: round(hold.stats),
        probPositive: prob === null ? null : r4(prob), verdict: verdict(hold.stats, prob),
        equity: equityCurve(hold.port, S.equityPoints), perCoin,
      };
    }

    // ---- prediction quality and range (cone) calibration for the chosen horizons ----
    say(`${tf.label}: measuring accuracy and range calibration`, 0.88);
    const usedH = [...new Set(Object.values(chosen).map((c) => c.H))];
    const quality = {}, cone = {};
    for (const H of usedH) {
      const measure = (from, to, k50, k80) => {
        let n = 0, correct = 0, up = 0, brier = 0, in50 = 0, in80 = 0;
        const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, up: 0 }));
        const confident = S.taus.map((tau) => ({ tau, n: 0, correct: 0 }));
        const hp = new Float64Array(200), hn = new Float64Array(200);
        const absZ = [];
        coins.forEach((co, c) => {
          const p = preds[H][c];
          const a = B.lowerBound(co.t, from), b = Math.min(B.upperBound(co.t, to) - 1, co.n - 1 - H);
          for (let i = a; i <= b; i++) {
            const pi = p[i];
            if (!(pi === pi)) continue;
            const y = co.lc[i + H] > co.lc[i] ? 1 : 0;
            n++;
            up += y;
            if ((pi >= 0.5) === (y === 1)) correct++;
            brier += (pi - y) * (pi - y);
            const bin = Math.max(0, Math.min(9, Math.floor((pi - 0.25) / 0.05)));
            bins[bin].n++;
            bins[bin].sumP += pi;
            bins[bin].up += y;
            for (const cf of confident) if (Math.abs(pi - 0.5) >= cf.tau && pi !== 0.5) {
              cf.n++;
              if ((pi > 0.5) === (y === 1)) cf.correct++;
            }
            const hb = Math.max(0, Math.min(199, Math.floor(pi * 200)));
            if (y) hp[hb]++; else hn[hb]++;
            const z = Math.abs((co.lc[i + H] - co.lc[i]) / (co.sig[i] * Math.sqrt(H)));
            if (k50 === undefined) absZ.push(z);
            else {
              if (z <= k50) in50++;
              if (z <= k80) in80++;
            }
          }
        });
        let negBelow = 0, auc = 0;
        const pos = up, neg = n - up;
        for (let b = 0; b < 200; b++) {
          auc += hp[b] * (negBelow + 0.5 * hn[b]);
          negBelow += hn[b];
        }
        const base = n ? up / n : 0;
        const out = {
          predictions: n,
          accuracy: n ? r4(correct / n) : null,
          upRate: r4(base),
          alwaysMajorityAccuracy: r4(Math.max(base, 1 - base)),
          auc: pos && neg ? r4(auc / (pos * neg)) : null,
          brier: n ? r4(brier / n) : null,
          brierBaseline: r4(base * (1 - base)),
          calibration: bins.filter((b) => b.n > 50).map((b) => ({ predicted: r4(b.sumP / b.n), actual: r4(b.up / b.n), n: b.n })),
          confident: confident.map((cf) => ({ tau: cf.tau, share: n ? r4(cf.n / n) : 0, accuracy: cf.n ? r4(cf.correct / cf.n) : null })),
        };
        if (k50 === undefined) {
          const zs = Float64Array.from(absZ).sort();
          out.k50 = r4(zs[Math.floor(zs.length * 0.5)]);
          out.k80 = r4(zs[Math.floor(zs.length * 0.8)]);
        } else {
          out.coverage50 = n ? r4(in50 / n) : null;
          out.coverage80 = n ? r4(in80 / n) : null;
        }
        return out;
      };
      const sel = measure(oosStart, selTo);
      const hold = measure(holdStart, endT, sel.k50, sel.k80);
      quality[H] = { selection: sel, holdout: hold };
      cone[H] = { k50: sel.k50, k80: sel.k80, holdoutCoverage50: hold.coverage50, holdoutCoverage80: hold.coverage80 };
    }

    // ---- production models: fitted on the most recent window ----
    say(`${tf.label}: fitting production model`, 0.94);
    const models = {};
    for (const H of usedH) {
      const set = trainingSet(coins, endT - W, endT - H * barMs, H, bufs);
      const beta = M.fit(set.Z, set.y, set.N, set.P, S.lambdaPerRow * set.N, null, 10);
      models[H] = {
        H, rows: set.N, trainedFrom: new Date(endT - W).toISOString(), trainedThrough: new Date(endT).toISOString(),
        beta: Array.from(beta, r6), mean: Array.from(set.mean, r6), std: Array.from(set.std, r6),
      };
    }

    // ---- recent out-of-sample probabilities (for chart markers) ----
    const recent = {};
    for (const H of usedH) {
      recent[H] = {};
      coins.forEach((co, c) => {
        const from = Math.max(0, co.n - S.recentBars);
        const p = [];
        for (let i = from; i < co.n; i++) p.push(preds[H][c][i] === preds[H][c][i] ? Math.round(preds[H][c][i] * 1000) / 1000 : null);
        recent[H][co.symbol] = { t0: co.t[from], p };
      });
    }

    say(`${tf.label}: done`, 1);
    return {
      timeframe: tfId, label: tf.label, barMs,
      generatedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - started) / 100) / 10,
      windows: { oosStart: S.oosStart, holdoutStart: S.holdoutStart, end: new Date(endT + barMs).toISOString() },
      coins: syms, horizons: cfg.horizons, windowDays: cfg.windowDays, trainLog,
      variants, buyHold, chosen, quality, cone, models, recent,
    };
  }

  K.research = { SETTINGS, runTimeframe, verdict, trainingSet };
})(typeof self !== 'undefined' ? self : this);
