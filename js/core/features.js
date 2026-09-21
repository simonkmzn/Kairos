/*
 * Machine-learning features. All strictly causal: row i only uses candles that
 * closed at or before bar i closes, plus funding rates published by then.
 * Every feature is scale-free (returns in volatility units, z-scores, ratios)
 * so one model can be trained on all coins pooled together.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const I = K.ind;

  const TIMEFRAMES = {
    '1h': { id: '1h', label: '1H', barMs: 3600000, intraday: true, tv: '60' },
    '4h': { id: '4h', label: '4H', barMs: 14400000, intraday: true, tv: '240' },
    '1d': { id: '1d', label: '1D', barMs: 86400000, intraday: false, tv: 'D' },
  };

  const FEATURES = [
    ['ret_1', 'Last candle', 'Momentum'],
    ['ret_4', 'Last 4 candles', 'Momentum'],
    ['ret_12', 'Last 12 candles', 'Momentum'],
    ['ret_48', 'Last 48 candles', 'Momentum'],
    ['ret_168', 'Last 168 candles', 'Momentum'],
    ['ema20_gap', 'Distance from 20 EMA', 'Trend'],
    ['ema50_gap', 'Distance from 50 EMA', 'Trend'],
    ['ema200_gap', 'Distance from 200 EMA', 'Trend'],
    ['rsi14', 'RSI (14)', 'Oscillator'],
    ['bb_pctb', 'Bollinger band position', 'Oscillator'],
    ['macd', 'MACD histogram', 'Oscillator'],
    ['vol_regime', 'Volatility expanding vs calm', 'Volatility'],
    ['volume_z', 'Volume vs normal', 'Volume'],
    ['clv', 'Where the last candle closed', 'Price action'],
    ['range_z', 'Candle size vs normal', 'Volatility'],
    ['dd_100', 'Distance below 100-candle high', 'Price action'],
    ['rebound_100', 'Distance above 100-candle low', 'Price action'],
    ['btc_ret_4', 'Bitcoin, last 4 candles', 'Market'],
    ['btc_ret_48', 'Bitcoin, last 48 candles', 'Market'],
    ['funding', 'Futures funding rate', 'Derivatives'],
    ['funding_3d', 'Funding rate, 3-day average', 'Derivatives'],
    ['dow_sin', 'Day of week', 'Calendar'],
    ['dow_cos', 'Day of week', 'Calendar'],
    ['hour_sin', 'Time of day', 'Calendar'],
    ['hour_cos', 'Time of day', 'Calendar'],
  ].map(([id, label, group]) => ({ id, label, group }));
  const D = FEATURES.length;
  const WARMUP = 210;

  function toSeries(candles) {
    const n = candles.length;
    const t = new Float64Array(n), open = new Float64Array(n), high = new Float64Array(n);
    const low = new Float64Array(n), close = new Float64Array(n), volume = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      t[i] = c[0]; open[i] = c[1]; high[i] = c[2]; low[i] = c[3]; close[i] = c[4]; volume[i] = c[5];
    }
    return { n, t, open, high, low, close, volume };
  }

  // Funding per bar:
  //   last[i]   latest rate published by the close of bar i (a feature)
  //   avg3d[i]  mean of the last 9 rates (3 days) published by then (a feature)
  //   during[i] sum of rates charged while a position is held through bar i (a cost)
  function fundingByBar(s, barMs, rates) {
    const n = s.n;
    const last = new Float64Array(n), avg3d = new Float64Array(n), during = new Float64Array(n);
    if (!rates || !rates.length) return { last, avg3d, during };
    const times = rates.map((r) => Math.round(r[0] / 60000) * 60000);
    let j = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const start = s.t[i], end = start + barMs;
      while (j < times.length && times[j] <= start) j++;
      let sum = 0;
      for (let q = j; q < times.length && times[q] <= end; q++) sum += rates[q][1];
      during[i] = sum;
      while (k < times.length && times[k] <= end) k++;
      if (k > 0) {
        last[i] = rates[k - 1][1];
        let a = 0, c = 0;
        for (let q = Math.max(0, k - 9); q < k; q++) { a += rates[q][1]; c++; }
        avg3d[i] = a / c;
      }
    }
    return { last, avg3d, during };
  }

  function basics(s) {
    const n = s.n;
    const lc = new Float64Array(n), r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      lc[i] = Math.log(s.close[i]);
      r[i] = i ? lc[i] - lc[i - 1] : NaN;
    }
    const v50 = I.ewmaVar(r, 50);
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sqrt(Math.max(v50[i], 1e-10));
    return { lc, r, sig };
  }

  /*
   * candles: [[openTimeMs, o, h, l, c, v], ...] oldest first (closed candles only)
   * tf:      TIMEFRAMES entry
   * btc:     result of compute() for BTC on the same timeframe (null when this IS BTC)
   * rates:   [[fundingTimeMs, rate], ...] or null
   */
  function compute(candles, tf, btc, rates) {
    const s = toSeries(candles);
    const n = s.n, barMs = tf.barMs;
    const { lc, r, sig } = basics(s);
    const v10 = I.ewmaVar(r, 10), v200 = I.ewmaVar(r, 200);
    const e20 = I.ema(s.close, 20), e50 = I.ema(s.close, 50), e200 = I.ema(s.close, 200);
    const e12 = I.ema(s.close, 12), e26 = I.ema(s.close, 26);
    const macdLine = new Float64Array(n);
    for (let i = 0; i < n; i++) macdLine[i] = e12[i] - e26[i];
    const macdSig = I.ema(macdLine, 9);
    const atr14 = I.atr(s.high, s.low, s.close, 14);
    const rsi14 = I.rsi(s.close, 14);
    const pctb = I.bollingerPctB(s.close, 20, 2);
    const logv = new Float64Array(n), lrange = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      logv[i] = Math.log(s.volume[i] + 1);
      lrange[i] = Math.log((s.high[i] - s.low[i]) / s.close[i] + 1e-6);
    }
    const vstat = I.rollingMeanStd(logv, 50), rstat = I.rollingMeanStd(lrange, 50);
    const hh = I.rollingMax(s.high, 100), ll = I.rollingMin(s.low, 100);
    const fund = fundingByBar(s, barMs, rates);

    let btcIdx = null;
    if (btc) {
      const map = new Map();
      for (let j = 0; j < btc.n; j++) map.set(btc.t[j], j);
      btcIdx = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const j = map.get(s.t[i]);
        btcIdx[i] = j === undefined ? -1 : j;
      }
    }
    const bLc = btc ? btc.lc : lc, bSig = btc ? btc.sig : sig;

    const X = new Float32Array(n * D);
    const valid = new Uint8Array(n);
    const TAU = 2 * Math.PI;
    const row = new Float64Array(D);
    for (let i = WARMUP; i < n; i++) {
      const sg = sig[i], c = s.close[i];
      const a = atr14[i] > 0 ? atr14[i] : c * sg;
      row[0] = r[i] / sg;
      row[1] = (lc[i] - lc[i - 4]) / (sg * 2);
      row[2] = (lc[i] - lc[i - 12]) / (sg * Math.sqrt(12));
      row[3] = (lc[i] - lc[i - 48]) / (sg * Math.sqrt(48));
      row[4] = (lc[i] - lc[i - 168]) / (sg * Math.sqrt(168));
      row[5] = (c - e20[i]) / a;
      row[6] = (c - e50[i]) / a;
      row[7] = (c - e200[i]) / a;
      row[8] = (rsi14[i] - 50) / 50;
      row[9] = pctb[i] - 0.5;
      row[10] = (macdLine[i] - macdSig[i]) / a;
      row[11] = 0.5 * Math.log(Math.max(v10[i], 1e-12) / Math.max(v200[i], 1e-12));
      row[12] = vstat.std[i] > 0 ? (logv[i] - vstat.mean[i]) / vstat.std[i] : 0;
      const rg = s.high[i] - s.low[i];
      row[13] = rg > 0 ? ((c - s.low[i]) - (s.high[i] - c)) / rg : 0;
      row[14] = rstat.std[i] > 0 ? (lrange[i] - rstat.mean[i]) / rstat.std[i] : 0;
      row[15] = (lc[i] - Math.log(hh[i])) / (sg * 10);
      row[16] = (lc[i] - Math.log(ll[i])) / (sg * 10);
      const j = btcIdx ? btcIdx[i] : i;
      if (j >= 168) {
        row[17] = (bLc[j] - bLc[j - 4]) / (bSig[j] * 2);
        row[18] = (bLc[j] - bLc[j - 48]) / (bSig[j] * Math.sqrt(48));
      } else {
        row[17] = 0;
        row[18] = 0;
      }
      row[19] = fund.last[i] * 1e4;
      row[20] = fund.avg3d[i] * 1e4;
      const closeT = s.t[i] + barMs;
      const day = Math.floor(closeT / 86400000);
      const dow = (((day + 4) % 7) + (closeT % 86400000) / 86400000) / 7;
      row[21] = Math.sin(TAU * dow);
      row[22] = Math.cos(TAU * dow);
      if (tf.intraday) {
        const hour = (closeT % 86400000) / 86400000;
        row[23] = Math.sin(TAU * hour);
        row[24] = Math.cos(TAU * hour);
      } else {
        row[23] = 0;
        row[24] = 0;
      }
      let ok = true;
      for (let k = 0; k < D; k++) if (!Number.isFinite(row[k])) { ok = false; break; }
      if (!ok) continue;
      X.set(row, i * D);
      valid[i] = 1;
    }
    return { n, t: s.t, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume, lc, sig, X, valid, fundingDuring: fund.during, D };
  }

  K.features = { TIMEFRAMES, FEATURES, D, WARMUP, toSeries, compute, fundingByBar };
})(typeof self !== 'undefined' ? self : this);
