importScripts('core/indicators.js', 'core/features.js', 'core/model.js', 'core/backtest.js', 'core/research.js', 'core/calendar.js', 'core/signal.js', 'core/tuner.js');

async function loadJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

self.onmessage = async (e) => {
  const { timeframes, symbols } = e.data;
  const S = KAIROS.tuner.SETTINGS;
  try {
    const funding = {};
    for (const s of S.mlSymbols) {
      try { funding[s] = (await loadJson(`../data/funding/${s}.json`)).rates; } catch (err) { funding[s] = null; }
    }
    let fng = null;
    try { fng = (await loadJson('../data/fng.json')).values; } catch (err) { self.postMessage({ type: 'progress', tf: timeframes[0], pct: 0, msg: 'data/fng.json missing: Fear & Greed signals will be zero (run update-data.cmd)' }); }
    // Daily candles give the intraday timeframes their higher-timeframe context.
    const htf = {};
    for (const s of symbols) {
      try { htf[s] = (await loadJson(`../data/1d/${s}.json`)).candles; } catch (err) { /* no daily data for this coin */ }
    }
    for (const tf of timeframes) {
      const data = {};
      for (const s of S.mlSymbols) {
        self.postMessage({ type: 'progress', tf, pct: 0, msg: `Loading ${tf} ${s}` });
        try { data[s] = { candles: (await loadJson(`../data/${tf}/${s}.json`)).candles, funding: funding[s] }; } catch (err) { /* coin missing */ }
      }
      const result = KAIROS.tuner.runTimeframe(tf, data, { symbols, fng, htf }, (msg, frac) => self.postMessage({ type: 'progress', tf, pct: Math.round(frac * 1000) / 10, msg }));
      self.postMessage({ type: 'result', tf, result });
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
};
