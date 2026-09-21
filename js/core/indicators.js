/*
 * Causal indicator math: out[i] only ever uses inputs at indices <= i.
 * Warm-up values are NaN. Classic script so it runs in pages, in Web Workers
 * (importScripts) and straight from disk.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const nan = (n) => new Float64Array(n).fill(NaN);

  // EMA seeded with the SMA of the first n values.
  function ema(x, n) {
    const out = nan(x.length);
    let s = 0;
    while (s < x.length && !Number.isFinite(x[s])) s++;
    if (x.length - s < n) return out;
    const k = 2 / (n + 1);
    let e = 0;
    for (let i = s; i < s + n; i++) e += x[i];
    e /= n;
    out[s + n - 1] = e;
    for (let i = s + n; i < x.length; i++) {
      e = x[i] * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  // Wilder RSI.
  function rsi(close, n) {
    const out = nan(close.length);
    if (close.length <= n) return out;
    const val = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) {
      const d = close[i] - close[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    g /= n;
    l /= n;
    out[n] = val(g, l);
    for (let i = n + 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
      l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = val(g, l);
    }
    return out;
  }

  // Wilder average true range.
  function atr(high, low, close, n) {
    const len = close.length, out = nan(len);
    if (len <= n) return out;
    const tr = (i) => Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    let a = 0;
    for (let i = 1; i <= n; i++) a += tr(i);
    a /= n;
    out[n] = a;
    for (let i = n + 1; i < len; i++) {
      a = (a * (n - 1) + tr(i)) / n;
      out[i] = a;
    }
    return out;
  }

  // Bollinger %B (0 = lower band, 1 = upper band).
  function bollingerPctB(close, n, mult) {
    const out = nan(close.length);
    let s = 0, ss = 0;
    for (let i = 0; i < close.length; i++) {
      s += close[i];
      ss += close[i] * close[i];
      if (i >= n) {
        s -= close[i - n];
        ss -= close[i - n] * close[i - n];
      }
      if (i >= n - 1) {
        const m = s / n, sd = Math.sqrt(Math.max(0, ss / n - m * m));
        out[i] = sd > 0 ? (close[i] - (m - mult * sd)) / (2 * mult * sd) : 0.5;
      }
    }
    return out;
  }

  // Exponentially weighted variance of a return series (valid after `span` observations).
  function ewmaVar(r, span) {
    const out = nan(r.length);
    const a = 2 / (span + 1);
    let v = NaN, count = 0;
    for (let i = 0; i < r.length; i++) {
      const x = r[i];
      if (Number.isFinite(x)) {
        v = count === 0 ? x * x : a * x * x + (1 - a) * v;
        count++;
      }
      if (count >= span) out[i] = v;
    }
    return out;
  }

  function rollingMeanStd(x, n) {
    const mean = nan(x.length), std = nan(x.length);
    let s = 0, ss = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i];
      ss += x[i] * x[i];
      if (i >= n) {
        s -= x[i - n];
        ss -= x[i - n] * x[i - n];
      }
      if (i >= n - 1) {
        const m = s / n;
        mean[i] = m;
        std[i] = Math.sqrt(Math.max(0, ss / n - m * m));
      }
    }
    return { mean, std };
  }

  function rollingExtreme(x, n, isMax) {
    const out = nan(x.length);
    const dq = new Int32Array(x.length);
    let head = 0, tail = 0;
    for (let i = 0; i < x.length; i++) {
      while (tail > head && (isMax ? x[dq[tail - 1]] <= x[i] : x[dq[tail - 1]] >= x[i])) tail--;
      dq[tail++] = i;
      if (dq[head] <= i - n) head++;
      if (i >= n - 1) out[i] = x[dq[head]];
    }
    return out;
  }

  K.ind = {
    ema, rsi, atr, bollingerPctB, ewmaVar, rollingMeanStd,
    rollingMax: (x, n) => rollingExtreme(x, n, true),
    rollingMin: (x, n) => rollingExtreme(x, n, false),
  };
})(typeof self !== 'undefined' ? self : this);
