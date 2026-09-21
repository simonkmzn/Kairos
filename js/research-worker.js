importScripts('core/indicators.js', 'core/features.js', 'core/model.js', 'core/backtest.js', 'core/research.js');

async function loadJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

self.onmessage = async (e) => {
  const { timeframes } = e.data;
  const S = KAIROS.research.SETTINGS;
  try {
    const funding = {};
    for (const s of S.symbols) {
      try { funding[s] = (await loadJson(`../data/funding/${s}.json`)).rates; } catch (err) { funding[s] = null; }
    }
    for (const tf of timeframes) {
      const data = {};
      for (const s of S.symbols) {
        self.postMessage({ type: 'progress', tf, pct: 0, msg: `Loading ${tf} ${s}` });
        try { data[s] = { candles: (await loadJson(`../data/${tf}/${s}.json`)).candles, funding: funding[s] }; } catch (err) { /* coin missing */ }
      }
      const result = KAIROS.research.runTimeframe(tf, data, (msg, frac) => self.postMessage({ type: 'progress', tf, pct: Math.round(frac * 1000) / 10, msg }));
      self.postMessage({ type: 'result', tf, result });
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
};
