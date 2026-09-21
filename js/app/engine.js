/*
 * Live inference: fetch candles, build the same features the model was trained
 * on, apply the production model, replay positions, project the price range.
 *
 * History shown on the chart is out-of-sample: candles up to the end of the
 * research run use the walk-forward probabilities saved by research.html;
 * candles after that use the production model, which never saw them.
 */
(function (root) {
  'use strict';
  const K = root.KAIROS;
  const F = K.features, M = K.model, B = K.backtest, Dt = K.data;
  const btcCache = new Map();

  function tfBundle(tf) {
    const mb = root.KAIROS_MODELS;
    return mb && mb.timeframes && mb.timeframes[tf] ? mb.timeframes[tf] : null;
  }

  function btcFeatures(tf) {
    const hit = btcCache.get(tf);
    if (hit && Date.now() - hit.at < 45000) return hit.promise;
    const promise = (async () => {
      const [k, r] = await Promise.all([Dt.klines('BTCUSDT', tf, 1000), Dt.funding('BTCUSDT', 100)]);
      return { klines: k, feat: F.compute(k.closed, F.TIMEFRAMES[tf], null, r) };
    })();
    btcCache.set(tf, { at: Date.now(), promise });
    promise.catch(() => btcCache.delete(tf));
    return promise;
  }

  function typedModel(m) {
    if (!m.__typed) m.__typed = { beta: Float64Array.from(m.beta), mean: Float64Array.from(m.mean), std: Float64Array.from(m.std) };
    return m.__typed;
  }

  // Merges sin/cos calendar pairs and sorts by absolute pull on the odds.
  function drivers(explain) {
    const groups = new Map();
    explain.features.forEach((f) => {
      const def = F.FEATURES[f.index];
      const key = def.id.startsWith('dow_') ? 'dow' : def.id.startsWith('hour_') ? 'hour' : def.id;
      const g = groups.get(key) || { id: key, label: def.label, group: def.group, contribution: 0 };
      g.contribution += f.contribution;
      groups.set(key, g);
    });
    return [...groups.values()].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }

  async function analyze(symbol, tf) {
    const tb = tfBundle(tf);
    if (!tb) return null;
    const tfDef = F.TIMEFRAMES[tf], barMs = tfDef.barMs;
    const btc = await btcFeatures(tf);
    let feat, kl;
    if (symbol === 'BTCUSDT') {
      feat = btc.feat;
      kl = btc.klines;
    } else {
      const [k, r] = await Promise.all([Dt.klines(symbol, tf, 1000), Dt.funding(symbol, 100)]);
      kl = k;
      feat = F.compute(k.closed, tfDef, btc.feat, r);
    }
    let last = feat.n - 1;
    while (last > 0 && !feat.valid[last]) last--;
    if (!feat.valid[last]) throw new Error('Not enough price history for this coin yet');

    const endMs = Date.parse(tb.end);
    const byH = {};
    const venues = {};
    for (const [vid, v] of Object.entries(tb.venues)) {
      const H = v.H;
      if (!byH[H]) {
        const model = typedModel(tb.models[H]);
        const probs = new Float32Array(feat.n).fill(NaN);
        const rec = tb.recent && tb.recent[H] && tb.recent[H][symbol];
        const recMap = new Map();
        if (rec) rec.p.forEach((p, j) => { if (p !== null) recMap.set(rec.t0 + j * barMs, p); });
        const from = Math.max(F.WARMUP, feat.n - 240);
        let oosFromResearch = 0, oosLive = 0;
        for (let i = from; i < feat.n; i++) {
          const t = feat.t[i];
          if (t + barMs <= endMs) {
            const p = recMap.get(t);
            if (p !== undefined) { probs[i] = p; oosFromResearch++; }
          } else if (feat.valid[i]) {
            probs[i] = M.predictRow(model, feat.X, i * F.D);
            oosLive++;
          }
        }
        byH[H] = { model, probs, from, oosFromResearch, oosLive };
      }
      const { model, probs, from } = byH[H];
      const p = probs[last] === probs[last] ? probs[last] : M.predictRow(model, feat.X, last * F.D);

      const positions = new Int8Array(feat.n);
      let pos = 0, since = -1;
      for (let i = from; i < feat.n; i++) {
        const pi = probs[i];
        if (pi === pi) {
          const np = B.decide(pos, pi, v.tau, v.longShort);
          if (np !== pos) since = i;
          pos = np;
        }
        positions[i] = pos;
      }

      const cone = tb.cone[H];
      const sig = feat.sig[last], lc = feat.lc[last];
      // Expected H-candle log move implied by the probability (normal approximation).
      const drift = (2 * p - 1) * sig * Math.sqrt(H) * Math.sqrt(2 / Math.PI);
      const path = [];
      for (let h = 0; h <= H; h++) {
        const mu = lc + drift * (h / H), s = sig * Math.sqrt(h);
        path.push({ h, mid: Math.exp(mu), lo50: Math.exp(mu - cone.k50 * s), hi50: Math.exp(mu + cone.k50 * s), lo80: Math.exp(mu - cone.k80 * s), hi80: Math.exp(mu + cone.k80 * s) });
      }

      venues[vid] = {
        id: vid, label: v.label, H, tau: v.tau, longShort: v.longShort, costPct: v.costPct,
        p, pos, sinceIndex: since, positions, probs, cone: path, coneStats: cone,
        drivers: drivers(M.explainRow(model, feat.X, last * F.D)),
        tfVerdict: v.verdict, tfHoldout: v.holdout, tfProbPositive: v.probPositive,
        coin: v.perCoin[symbol] || null, quality: tb.quality[H] || null,
      };
    }
    return {
      symbol, tf, barMs, feat, last, lastT: feat.t[last], forming: kl.forming,
      nextCloseAt: feat.t[last] + 2 * barMs, venues, researchEnd: tb.end, holdoutStart: tb.holdoutStart, buyHold: tb.buyHold,
    };
  }

  K.engine = { analyze, tfBundle };
})(typeof self !== 'undefined' ? self : this);
