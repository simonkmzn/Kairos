/*
 * Hybrid signal engine: sub-signals in seven groups, each scaled to [-1, +1]
 * with bullish positive. Weights, the call bars, the exit setup and the
 * probability calibration are tuned by tuner.js on history and stored in
 * config/signal.js. Everything is causal: bar i only uses closed bars <= i.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const I = K.ind;
  const WARMUP = 210, DAY = 86400000;
  const SR_LOOKBACK = 150, SR_K = 3;

  const GROUPS = [
    { id: 'ml', label: 'ML model', desc: 'Logistic-regression model on 25 features, retrained on the trailing window.' },
    { id: 'structure', label: 'Structure', desc: 'Where price sits in its recent range, breakouts, and swing-based support / resistance.' },
    { id: 'momentum', label: 'Momentum', desc: 'RSI, MACD, Bollinger position, moving-average alignment and volume-backed candles.' },
    { id: 'volatility', label: 'Volatility', desc: 'ATR expansion in the direction of the move and Bollinger-squeeze breakouts.' },
    { id: 'context', label: 'Context', desc: "Bitcoin's direction (for alts), the daily-chart trend, where the candle closed in its range, funding-rate crowding." },
    { id: 'patterns', label: 'Patterns', desc: 'Engulfing candles, pin bars after a move, and fair-value gaps.' },
    { id: 'news', label: 'News & events', desc: 'Crypto Fear & Greed sentiment index and the Fed decision calendar. These are tested; live headlines and your event bias are layered on top, untested.' },
  ];

  const SIGNALS = [
    ['ml', 'ML probability', 'ml', "The model's chance of a rise, centred on 50%."],
    ['range_pos', '100-bar range position', 'structure', 'Where price sits between the 100-bar low (-1) and high (+1).'],
    ['breakout', '20-bar breakout', 'structure', 'Close beyond the prior 20-bar high (+) or low (-), in ATRs.'],
    ['sr', 'Support / resistance', 'structure', 'Near a swing support (+, bounce) or a swing resistance (-).'],
    ['rsi', 'RSI (14)', 'momentum', 'RSI above 50 is positive; 75 = +1.'],
    ['macd', 'MACD histogram', 'momentum', 'MACD minus its signal line, in half-ATRs.'],
    ['bbp', 'Bollinger %B', 'momentum', 'Position inside the Bollinger bands: lower band -1, upper band +1.'],
    ['ma_align', 'MA alignment', 'momentum', 'Price > EMA20 > EMA50 > EMA200 = +1; the reverse = -1.'],
    ['vol_dir', 'Volume-backed candle', 'momentum', 'Candle direction weighted by how unusual its volume was.'],
    ['vol_expansion', 'ATR expansion', 'volatility', "Last move's direction when ATR(14) is expanding vs ATR(50)."],
    ['squeeze', 'Squeeze breakout', 'volatility', 'Bollinger width near a 100-bar low with a close outside the bands.'],
    ['btc_trend', 'BTC 48-bar trend', 'context', "Bitcoin's 48-bar move in volatility units (alts only)."],
    ['btc_short', 'BTC 4-bar move', 'context', "Bitcoin's 4-bar move in volatility units (alts only)."],
    ['clv', 'Close location', 'context', 'Closed near the candle high (+1) or low (-1).'],
    ['funding', 'Funding (contrarian)', 'context', 'High positive funding = crowded longs = negative.'],
    ['engulf', 'Engulfing candle', 'patterns', 'Bullish (+1) or bearish (-1) engulfing candle.'],
    ['pin', 'Pin bar', 'patterns', 'Hammer after a decline (+1) or shooting star after a rise (-1).'],
    ['fvg', 'Fair-value gap', 'patterns', 'Recent three-candle gap up (+) or down (-), fading over a few bars.'],
    ['fng', 'Fear & Greed level', 'news', 'Crypto Fear & Greed index the day before: extreme greed +1, extreme fear -1. Sign learned by the tuner (greed can be a contrarian sell).'],
    ['fng_chg', 'Fear & Greed 7-day change', 'news', 'How much market mood shifted over the last week (+30 points = +1).'],
    ['fomc', 'Fed decision ahead', 'news', 'Ramps from 0 to 1 over the 48 hours before an FOMC rate decision.'],
    ['htf_align', 'Daily trend alignment', 'context', 'On the daily chart: price > EMA20 > EMA50 > EMA200 = +1, the reverse = -1 (zero on the 1D timeframe itself).'],
    ['htf_mom', 'Daily 12-day momentum', 'context', 'The last 12 daily candles in volatility units (zero on the 1D timeframe itself).'],
  ].map(([id, label, group, desc]) => ({ id, label, group, desc }));
  const NS = SIGNALS.length;
  const GROUP_INDEX = SIGNALS.map((s) => GROUPS.findIndex((g) => g.id === s.group));

  const clip = (x) => (x > 1 ? 1 : x < -1 ? -1 : x);
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  function logStats(close) {
    const n = close.length, lc = new Float64Array(n), r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      lc[i] = Math.log(close[i]);
      r[i] = i ? lc[i] - lc[i - 1] : NaN;
    }
    const v = I.ewmaVar(r, 50), sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sqrt(Math.max(v[i], 1e-10));
    return { lc, sig };
  }

  // Daily-chart context for intraday timeframes, from closed 1D candles.
  function htfContext(candles1d) {
    const s = K.features.toSeries(candles1d), n = s.n, c = s.close;
    const e20 = I.ema(c, 20), e50 = I.ema(c, 50), e200 = I.ema(c, 200);
    const { lc, sig } = logStats(c);
    const align = new Float64Array(n), mom = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      align[i] = i >= 199 ? (sgn(c[i] - e20[i]) + sgn(e20[i] - e50[i]) + sgn(e50[i] - e200[i])) / 3 : 0;
      mom[i] = i >= 60 && sig[i] > 0 ? clip((lc[i] - lc[i - 12]) / (sig[i] * Math.sqrt(12)) / 2) : 0;
    }
    return { t: s.t, n, align, mom };
  }

  // Fractal swing points (k bars each side, confirmed k bars later); nearest
  // confirmed swing low below the close = support, swing high above = resistance.
  function swingLevels(h, l, c, n, k, look) {
    const isSH = new Uint8Array(n), isSL = new Uint8Array(n);
    for (let j = k; j < n - k; j++) {
      let sh = 1, sl = 1;
      for (let m = 1; m <= k && (sh || sl); m++) {
        if (!(h[j] > h[j - m] && h[j] >= h[j + m])) sh = 0;
        if (!(l[j] < l[j - m] && l[j] <= l[j + m])) sl = 0;
      }
      isSH[j] = sh;
      isSL[j] = sl;
    }
    const support = new Float64Array(n).fill(NaN), resistance = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let sup = NaN, res = NaN;
      for (let j = i - k, jmin = Math.max(0, i - look); j >= jmin; j--) {
        if (isSL[j] && l[j] < c[i] && !(l[j] <= sup)) sup = l[j];
        if (isSH[j] && h[j] > c[i] && !(h[j] >= res)) res = h[j];
      }
      support[i] = sup;
      resistance[i] = res;
    }
    return { support, resistance };
  }

  // Fear & Greed per bar: the latest daily value published strictly before the bar opened,
  // and the value 7 days before that one.
  function fngByBar(s, values) {
    const n = s.n, level = new Float64Array(n).fill(NaN), prev7 = new Float64Array(n).fill(NaN);
    if (!values || !values.length) return { level, prev7 };
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k < values.length && values[k][0] < s.t[i]) k++;
      if (k > 0) {
        level[i] = values[k - 1][1];
        if (k - 8 >= 0) prev7[i] = values[k - 8][1];
      }
    }
    return { level, prev7 };
  }

  // Daily context per bar: the last daily candle that CLOSED before this bar opened.
  function htfByBar(s, htf) {
    const n = s.n, align = new Float64Array(n), mom = new Float64Array(n);
    if (!htf) return { align, mom };
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k < htf.n && htf.t[k] + DAY <= s.t[i]) k++;
      if (k > 0) {
        align[i] = htf.align[k - 1];
        mom[i] = htf.mom[k - 1];
      }
    }
    return { align, mom };
  }

  /*
   * s:     { n, t, open, high, low, close, volume } closed candles, oldest first
   * ml:    Float32Array of ML probabilities per bar (NaN = none) or null
   * btc:   { t, n, lc, sig } for BTC on the same timeframe (null when this IS BTC)
   * rates: funding [[timeMs, rate], ...] or null
   * extra: { fng: [[dayMs, value], ...], htf: htfContext() result } or null
   */
  function compute(s, ml, btc, rates, barMs, extra) {
    const n = s.n, o = s.open, h = s.high, l = s.low, c = s.close, v = s.volume;
    const fng = fngByBar(s, extra && extra.fng);
    const htf = htfByBar(s, extra && extra.htf);
    const e20 = I.ema(c, 20), e50 = I.ema(c, 50), e200 = I.ema(c, 200), e12 = I.ema(c, 12), e26 = I.ema(c, 26);
    const macdLine = new Float64Array(n);
    for (let i = 0; i < n; i++) macdLine[i] = e12[i] - e26[i];
    const macdSig = I.ema(macdLine, 9);
    const atr14 = I.atr(h, l, c, 14), atr50 = I.atr(h, l, c, 50);
    const rsi14 = I.rsi(c, 14), pctb = I.bollingerPctB(c, 20, 2);
    const bstat = I.rollingMeanStd(c, 20);
    const bw = new Float64Array(n);
    for (let i = 0; i < n; i++) bw[i] = bstat.mean[i] > 0 ? (4 * bstat.std[i]) / bstat.mean[i] : NaN;
    const bwMin = I.rollingMin(bw, 100);
    const logv = new Float64Array(n);
    for (let i = 0; i < n; i++) logv[i] = Math.log(v[i] + 1);
    const vstat = I.rollingMeanStd(logv, 50);
    const hh100 = I.rollingMax(h, 100), ll100 = I.rollingMin(l, 100), hh20 = I.rollingMax(h, 20), ll20 = I.rollingMin(l, 20);
    const atrPct = new Float64Array(n);
    for (let i = 0; i < n; i++) atrPct[i] = atr14[i] / c[i];
    const apMin = I.rollingMin(atrPct, 100), apMax = I.rollingMax(atrPct, 100);
    const { support, resistance } = swingLevels(h, l, c, n, SR_K, SR_LOOKBACK);
    const fund = K.features.fundingByBar(s, barMs, rates);

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

    const S = new Float32Array(n * NS), valid = new Uint8Array(n);
    let fvg = 0;
    for (let i = WARMUP; i < n; i++) {
      const a = atr14[i];
      if (!(a > 0)) continue;
      const ci = c[i], off = i * NS;

      const p = ml ? ml[i] : NaN;
      S[off] = p === p ? clip((p - 0.5) * 8) : 0;

      const span100 = hh100[i] - ll100[i];
      S[off + 1] = span100 > 0 ? clip((2 * (ci - ll100[i])) / span100 - 1) : 0;
      const ph = hh20[i - 1], pl = ll20[i - 1];
      S[off + 2] = ci > ph ? clip((ci - ph) / a) : ci < pl ? -clip((pl - ci) / a) : 0;
      let sr = 0;
      if (support[i] === support[i]) sr += Math.max(0, 1 - (ci - support[i]) / (1.5 * a));
      if (resistance[i] === resistance[i]) sr -= Math.max(0, 1 - (resistance[i] - ci) / (1.5 * a));
      S[off + 3] = clip(sr);

      S[off + 4] = clip((rsi14[i] - 50) / 25);
      S[off + 5] = clip((macdLine[i] - macdSig[i]) / (0.5 * a));
      S[off + 6] = clip(2 * pctb[i] - 1);
      S[off + 7] = (sgn(ci - e20[i]) + sgn(e20[i] - e50[i]) + sgn(e50[i] - e200[i])) / 3;
      const vz = vstat.std[i] > 0 ? (logv[i] - vstat.mean[i]) / vstat.std[i] : 0;
      S[off + 8] = sgn(ci - o[i]) * Math.min(1, Math.max(0, vz / 2));

      S[off + 9] = atr50[i] > 0 ? sgn(ci - c[i - 1]) * clip((a / atr50[i] - 1) * 2) : 0;
      const squeezed = bwMin[i] === bwMin[i] && bw[i] <= bwMin[i] * 1.1;
      S[off + 10] = squeezed ? (pctb[i] > 1 ? 1 : pctb[i] < 0 ? -1 : 0) : 0;

      let b48 = 0, b4 = 0;
      if (btc) {
        const j = btcIdx[i];
        if (j >= 48 && btc.sig[j] > 0) {
          b48 = clip((btc.lc[j] - btc.lc[j - 48]) / (btc.sig[j] * Math.sqrt(48)) / 2);
          b4 = clip((btc.lc[j] - btc.lc[j - 4]) / (btc.sig[j] * 2) / 2);
        }
      }
      S[off + 11] = b48;
      S[off + 12] = b4;
      const rg = h[i] - l[i];
      S[off + 13] = rg > 0 ? (2 * (ci - l[i])) / rg - 1 : 0;
      S[off + 14] = -clip(fund.last[i] / 0.0003);

      const body = ci - o[i], pbody = c[i - 1] - o[i - 1];
      let eng = 0;
      if (body > 0 && pbody < 0 && ci >= o[i - 1] && o[i] <= c[i - 1] && body > -pbody) eng = 1;
      else if (body < 0 && pbody > 0 && ci <= o[i - 1] && o[i] >= c[i - 1] && -body > pbody) eng = -1;
      S[off + 15] = eng;
      let pin = 0;
      if (rg > 0) {
        const bd = Math.abs(body), upW = h[i] - Math.max(o[i], ci), dnW = Math.min(o[i], ci) - l[i];
        const bodyRef = Math.max(bd, 0.05 * rg), wickCap = Math.max(bd, 0.1 * rg);
        if (dnW >= 2 * bodyRef && upW <= wickCap && c[i - 1] < c[i - 4]) pin = 1;
        else if (upW >= 2 * bodyRef && dnW <= wickCap && c[i - 1] > c[i - 4]) pin = -1;
      }
      S[off + 16] = pin;
      fvg = fvg * 0.6 + (l[i] > h[i - 2] ? 1 : h[i] < l[i - 2] ? -1 : 0);
      S[off + 17] = clip(fvg);

      S[off + 18] = fng.level[i] === fng.level[i] ? (fng.level[i] - 50) / 50 : 0;
      S[off + 19] = fng.prev7[i] === fng.prev7[i] ? clip((fng.level[i] - fng.prev7[i]) / 30) : 0;
      S[off + 20] = K.calendar.fomcAhead(s.t[i] + barMs, 48);
      S[off + 21] = htf.align[i];
      S[off + 22] = htf.mom[i];

      for (let k = 0; k < NS; k++) if (!(S[off + k] === S[off + k])) S[off + k] = 0;
      valid[i] = 1;
    }
    const atrPos = new Float64Array(n);
    for (let i = 0; i < n; i++) atrPos[i] = apMax[i] > apMin[i] ? (atrPct[i] - apMin[i]) / (apMax[i] - apMin[i]) : 0.5;
    return { n, S, valid, atr: atr14, support, resistance, atrPos, rsi: rsi14, e20, e50, e200, fng: fng.level, htfAlign: htf.align };
  }

  function composite(S, off, w) {
    let c = 0;
    for (let k = 0; k < NS; k++) c += w[k] * S[off + k];
    return c;
  }
  function groupScores(S, off, w) {
    const g = new Float64Array(GROUPS.length);
    for (let k = 0; k < NS; k++) g[GROUP_INDEX[k]] += w[k] * S[off + k];
    return g;
  }
  function maxScore(w) {
    let s = 0;
    for (let k = 0; k < NS; k++) s += Math.abs(w[k]);
    return s;
  }
  // theta: a number (same bar both ways) or [longBar, shortBar].
  const barLong = (th) => (Array.isArray(th) ? th[0] : th), barShort = (th) => (Array.isArray(th) ? th[1] : th);
  const decide = (c, theta) => (c > barLong(theta) ? 1 : c < -barShort(theta) ? -1 : 0);
  // P(a trade in direction d works out), calibrated on history: sigmoid(a + b·|score|).
  function probability(c, d, cal) {
    const ab = d > 0 ? cal.long : cal.short;
    return 1 / (1 + Math.exp(-(ab[0] + ab[1] * Math.abs(c))));
  }

  // Initial stop distance in price units. 'atr' / 'trail': k × ATR. 'sr': just beyond the
  // nearest swing support (long) / resistance (short), kept between 1 and 3 ATR.
  const SR_BUFFER = 0.25, SR_MIN = 1, SR_MAX = 3, SR_DEFAULT = 2;
  function stopDistance(mode, k, atr, d, entry, support, resistance) {
    if (mode !== 'sr') return k * atr;
    const lvl = d > 0 ? support : resistance;
    if (!(lvl === lvl) || !((d > 0 && lvl < entry) || (d < 0 && lvl > entry))) return SR_DEFAULT * atr;
    return Math.min(SR_MAX * atr, Math.max(SR_MIN * atr, Math.abs(entry - lvl) + SR_BUFFER * atr));
  }
  // combo: { stopMode, slAtr, rr (null = no fixed target), be }; ctx: { support, resistance }
  function levels(entry, atr, d, combo, ctx) {
    const slDist = stopDistance(combo.stopMode || 'atr', combo.slAtr, atr, d, entry, ctx && ctx.support, ctx && ctx.resistance);
    const rr = combo.rr || null, tpDist = rr ? slDist * rr : null;
    return { entry, stop: entry - d * slDist, target: rr ? entry + d * tpDist : null, riskPct: slDist / entry, rewardPct: rr ? tpDist / entry : null, rr, slDist };
  }
  const stopLabel = (cb) => (cb.stopMode === 'sr' ? 'S/R stop' : cb.stopMode === 'trail' ? `${cb.slAtr}×ATR trailing stop` : `${cb.slAtr}×ATR stop`);
  const comboLabel = (cb) => `${stopLabel(cb)}${cb.be ? ' → breakeven at +1R' : ''} · ${cb.rr ? 'target 1:' + cb.rr : 'no fixed target'}`;
  const manageText = (cb) => [
    cb.stopMode === 'trail' ? `stop trails ${cb.slAtr}×ATR behind the best price since entry` : null,
    cb.be ? 'stop moves to entry once the trade is +1R in profit' : null,
    !cb.rr ? 'no fixed target: exit on the trailing stop or the time-out' : null,
  ].filter(Boolean).join('; ');
  // Fraction of the account to risk: quarter-Kelly on the calibrated odds, capped.
  function kellyRisk(p, b, cap) {
    if (!(b > 0)) return 0;
    const f = 0.25 * (p - (1 - p) / b);
    return Math.max(0, Math.min(cap || 0.02, f));
  }

  // Situation a signal fires in: volatility regime × direction × strength.
  const volBucket = (atrPos) => (atrPos < 0.33 ? 0 : atrPos < 0.66 ? 1 : 2);
  const VOL_LABEL = ['low volatility', 'normal volatility', 'high volatility'];
  function cellOf(atrPos, d, c, theta, maxScore) {
    const th = d > 0 ? barLong(theta) : barShort(theta);
    const strong = (Math.abs(c) - th) / Math.max(1e-9, maxScore - th) >= 0.33;
    return `v${volBucket(atrPos)}|${d > 0 ? 'long' : 'short'}|${strong ? 'strong' : 'call'}`;
  }
  function cellLabel(cell) {
    const [v, d, s] = cell.split('|');
    return `${VOL_LABEL[+v[1]]}, ${s === 'strong' ? 'strong' : 'moderate'} ${d}`;
  }

  K.signal = { WARMUP, GROUPS, SIGNALS, NS, GROUP_INDEX, logStats, htfContext, compute, composite, groupScores, maxScore, decide, barLong, barShort, probability, stopDistance, levels, stopLabel, comboLabel, manageText, kellyRisk, volBucket, cellOf, cellLabel };
})(typeof self !== 'undefined' ? self : this);
