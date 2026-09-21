/*
 * Portfolio backtest of model probabilities.
 *
 * At the close of candle i the model gives p = P(up over the next H candles).
 *   flat  -> long  if p >= 0.5 + tau
 *   flat  -> short if p <= 0.5 - tau            (long/short mode only)
 *   long  -> exits when p < 0.5 (flips short if p <= 0.5 - tau in long/short mode)
 *   short -> exits when p > 0.5 (flips long if p >= 0.5 + tau)
 * The position earns candle i+1's return. Every change pays `cost` per unit of
 * notional traded; futures positions also pay/receive the funding charged
 * during the candle. Coins are equal-weight; portfolio return per candle is the
 * mean across coins trading that candle.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});

  let bufSum = new Float64Array(1 << 16), bufCnt = new Uint16Array(1 << 16);

  function decide(pos, p, tau, ls) {
    const up = p >= 0.5 + tau, dn = p <= 0.5 - tau;
    if (pos === 0) return up ? 1 : ls && dn ? -1 : 0;
    if (pos === 1) return p >= 0.5 ? 1 : ls && dn ? -1 : 0;
    return p <= 0.5 ? -1 : up ? 1 : 0;
  }

  /*
   * coins: [{ symbol, t, close, fundingDuring }]
   * preds: [Float32Array] probabilities aligned with each coin (NaN = none)
   * cfg:   { tau, longShort, cost, funding, barMs }
   * window [t0, t1] in candle open-time ms (inclusive)
   */
  function simulate(coins, preds, cfg, t0, t1, detail) {
    const barMs = cfg.barMs;
    const N = Math.floor((t1 - t0) / barMs) + 1;
    if (N > bufSum.length) {
      bufSum = new Float64Array(N);
      bufCnt = new Uint16Array(N);
    }
    const sum = bufSum, cnt = bufCnt;
    sum.fill(0, 0, N);
    cnt.fill(0, 0, N);
    const { tau, longShort, cost, funding } = cfg;
    let trades = 0, wins = 0, sumWin = 0, sumLoss = 0, holdBars = 0, inBars = 0, coinBars = 0, turnover = 0;
    const perCoin = detail ? [] : null;

    for (let c = 0; c < coins.length; c++) {
      const coin = coins[c], p = preds[c], close = coin.close, t = coin.t, fd = coin.fundingDuring;
      let i0 = lowerBound(t, t0), i1 = upperBound(t, t1) - 1;
      while (i0 <= i1 && !(p[i0] === p[i0])) i0++;
      if (i1 - i0 < 2) continue;
      const rets = detail ? new Float64Array(N).fill(NaN) : null;
      const cTrades = detail ? [] : null;
      let pos = 0, tradeEq = 1, entry = 0;
      let slot = 0;
      for (let i = i0; i < i1; i++) {
        const pi = p[i];
        const np = pi === pi ? decide(pos, pi, tau, longShort) : pos;
        const move = close[i + 1] / close[i] - 1;
        const fund = funding ? fd[i + 1] : 0;
        if (np !== pos) {
          const traded = Math.abs(np - pos);
          turnover += traded;
          if (pos !== 0) {
            tradeEq *= 1 - cost;
            const r = tradeEq - 1;
            trades++;
            holdBars += i - entry;
            if (r > 0) { wins++; sumWin += r; } else sumLoss += r;
            if (detail) cTrades.push({ side: pos, entryT: t[entry], exitT: t[i], ret: r });
          }
          if (np !== 0) {
            tradeEq = 1 - cost;
            entry = i;
          }
        }
        let ret = np * move - Math.abs(np - pos) * cost - np * fund;
        if (np !== 0) {
          tradeEq *= 1 + np * move - np * fund;
          inBars++;
        }
        pos = np;
        if (i + 1 === i1 && pos !== 0) {
          ret -= cost;
          tradeEq *= 1 - cost;
          const r = tradeEq - 1;
          trades++;
          holdBars += i + 1 - entry;
          if (r > 0) { wins++; sumWin += r; } else sumLoss += r;
          if (detail) cTrades.push({ side: pos, entryT: t[entry], exitT: t[i + 1], ret: r, openAtEnd: true });
        }
        slot = Math.round((t[i + 1] - t0) / barMs);
        if (slot >= 0 && slot < N) {
          sum[slot] += ret;
          cnt[slot]++;
          if (detail) rets[slot] = ret;
        }
        coinBars++;
      }
      if (detail) perCoin.push({ symbol: coin.symbol, rets, trades: cTrades });
    }

    const bpy = (365 * 86400000) / barMs;
    const port = detail ? new Float64Array(N).fill(NaN) : null;
    let n = 0, s1 = 0, s2 = 0, eq = 1, peak = 1, maxDD = 0;
    for (let j = 0; j < N; j++) {
      if (!cnt[j]) continue;
      const r = sum[j] / cnt[j];
      n++;
      s1 += r;
      s2 += r * r;
      eq *= 1 + r;
      if (eq > peak) peak = eq;
      else if (eq / peak - 1 < maxDD) maxDD = eq / peak - 1;
      if (detail) port[j] = r;
    }
    const mu = n ? s1 / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mu * mu)) : 0;
    const years = n / bpy;
    const stats = {
      bars: n,
      years,
      totalReturn: eq - 1,
      cagr: years > 0 ? Math.pow(Math.max(eq, 1e-9), 1 / years) - 1 : 0,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(bpy) : 0,
      vol: sd * Math.sqrt(bpy),
      maxDD,
      trades,
      winRate: trades ? wins / trades : 0,
      avgWin: wins ? sumWin / wins : 0,
      avgLoss: trades - wins ? sumLoss / (trades - wins) : 0,
      profitFactor: sumLoss < 0 ? Math.min(sumWin / -sumLoss, 99) : sumWin > 0 ? 99 : 0,
      expectancy: trades ? (sumWin + sumLoss) / trades : 0,
      avgHoldBars: trades ? holdBars / trades : 0,
      exposure: coinBars ? inBars / coinBars : 0,
      tradesPerCoinYear: coinBars ? trades / (coinBars / bpy) : 0,
    };
    return detail ? { stats, port, perCoin, t0, N } : { stats };
  }

  function statsOf(rets, barMs) {
    const bpy = (365 * 86400000) / barMs;
    let n = 0, s1 = 0, s2 = 0, eq = 1, peak = 1, maxDD = 0;
    for (let j = 0; j < rets.length; j++) {
      const r = rets[j];
      if (!(r === r)) continue;
      n++;
      s1 += r;
      s2 += r * r;
      eq *= 1 + r;
      if (eq > peak) peak = eq;
      else if (eq / peak - 1 < maxDD) maxDD = eq / peak - 1;
    }
    const mu = n ? s1 / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mu * mu)) : 0;
    const years = n / bpy;
    return { bars: n, totalReturn: eq - 1, cagr: years > 0 ? Math.pow(Math.max(eq, 1e-9), 1 / years) - 1 : 0, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(bpy) : 0, maxDD };
  }

  // Circular block bootstrap: probability the true Sharpe of `rets` is above zero.
  function probPositive(rets, block, iters, rand) {
    const x = [];
    for (let j = 0; j < rets.length; j++) if (rets[j] === rets[j]) x.push(rets[j]);
    const n = x.length;
    if (n < block * 4) return null;
    let pos = 0;
    for (let it = 0; it < iters; it++) {
      let s = 0, f = 0;
      while (f < n) {
        const start = Math.floor(rand() * n);
        for (let q = 0; q < block && f < n; q++, f++) s += x[(start + q) % n];
      }
      if (s > 0) pos++;
    }
    return pos / iters;
  }

  function lowerBound(a, v) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m] < v) lo = m + 1; else hi = m;
    }
    return lo;
  }
  function upperBound(a, v) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m] <= v) lo = m + 1; else hi = m;
    }
    return lo;
  }

  K.backtest = { decide, simulate, statsOf, probPositive, lowerBound, upperBound };
})(typeof self !== 'undefined' ? self : this);
