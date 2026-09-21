(function () {
  'use strict';
  const R = window.KAIROS_RESEARCH;
  const $ = (s) => document.querySelector(s);
  const MINUS = '−';
  const NS = 'http://www.w3.org/2000/svg';
  window.KAIROS.tooltips.init({});

  if (!R || !R.timeframes || !Object.keys(R.timeframes).length) {
    $('#lede').innerHTML = 'No results yet. Run <code>serve.cmd</code> and open <a href="research.html">research.html</a> to train and test the models.';
    return;
  }

  const TFS = ['1h', '4h', '1d'].filter((tf) => R.timeframes[tf]);
  const VENUES = ['spot', 'perp'];
  const VENUE_NAME = { spot: 'Spot · long only', perp: 'Futures · long & short' };
  const COLORS = { spot: '#22d3ee', perp: '#c084fc', bh: '#6f7890' };
  const BADGE = { edge: 'Tested edge', weak: 'Weak edge', none: 'No edge' };
  const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
  const pct = (v, d = 1) => (ok(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%' : '—');
  const pctAbs = (v, d = 1) => (ok(v) ? (v * 100).toFixed(d) + '%' : '—');
  const num = (v, d = 2) => (ok(v) ? (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d) : '—');
  const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const tfLabel = (tf) => R.timeframes[tf].label;
  const horizon = (tf, H) => {
    const hours = (R.timeframes[tf].barMs * H) / 3600000;
    return hours < 24 || hours % 24 ? `${hours}h` : `${hours / 24}d`;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tip = (t) => `<button class="tip" type="button" data-tip-text="${esc(t)}" aria-label="Explain">?</button>`;

  // ---------------- headline ----------------
  const any = TFS[0] ? R.timeframes[TFS[0]] : null;
  const setups = TFS.flatMap((tf) => VENUES.map((v) => ({ tf, v, c: R.timeframes[tf].chosen[v] })));
  const edges = setups.filter((s) => s.c.verdict === 'edge');
  const weak = setups.filter((s) => s.c.verdict === 'weak');
  const accs = TFS.map((tf) => {
    const r = R.timeframes[tf];
    const H = r.chosen.perp.H;
    return r.quality[H] ? r.quality[H].holdout.accuracy : null;
  }).filter(ok);
  const covs = TFS.map((tf) => R.timeframes[tf].cone[R.timeframes[tf].chosen.perp.H].holdoutCoverage80).filter(ok);
  const span = (arr, d) => {
    const lo = pctAbs(Math.min(...arr), d), hi = pctAbs(Math.max(...arr), d);
    return lo === hi ? lo : `${lo}–${hi}`;
  };
  $('#lede').innerHTML =
    `Every number here comes from data the model never trained on (${date(any.windows.holdoutStart)} → today), after trading fees. ` +
    (edges.length
      ? `<b>${edges.length} of ${setups.length}</b> setups cleared the bar for a tested edge: ${edges.map((s) => `${tfLabel(s.tf)} ${s.v === 'spot' ? 'spot' : 'futures'}`).join(', ')}. `
      : `<b>None of the ${setups.length} setups cleared the bar for a reliable edge</b>${weak.length ? `; ${weak.length} made money without passing it` : ''}. `) +
    `Direction calls were right <b>${accs.length ? span(accs, 1) : '—'}</b> of the time, close to a coin flip. ` +
    `The price-range forecasts are the strong part: price landed inside the 80% range <b>${covs.length ? span(covs, 0) : '—'}</b> of the time.`;

  // ---------------- tiles ----------------
  $('#tiles').innerHTML = TFS.map((tf) => {
    const r = R.timeframes[tf];
    const bh = r.buyHold.holdout;
    const q = r.quality[r.chosen.perp.H] || r.quality[r.chosen.spot.H];
    return `<div class="card tile">
      <div class="tile-head"><h3>${r.label} candles</h3><span class="muted" style="font-size:12px">Buy &amp; hold ${pct(bh.totalReturn, 0)}</span></div>
      <div class="tile-row">${VENUES.map((v) => {
        const c = r.chosen[v];
        return `<div class="venue"><div class="top"><span class="name">${v === 'spot' ? 'Spot' : 'Futures'}</span><span class="badge ${c.verdict}">${BADGE[c.verdict]}</span></div>
          <div class="ret ${c.holdout.totalReturn >= 0 ? 'up' : 'down'}">${pct(c.holdout.totalReturn, 0)}</div>
          <div class="vs">Sharpe ${num(c.holdout.sharpe)} · B&amp;H ${num(bh.sharpe)}</div></div>`;
      }).join('')}</div>
      <div class="acc">Direction accuracy <b>${q ? pctAbs(q.holdout.accuracy) : '—'}</b> vs always guessing the majority <b>${q ? pctAbs(q.holdout.alwaysMajorityAccuracy) : '—'}</b></div>
    </div>`;
  }).join('');

  // ---------------- tabs ----------------
  let current = TFS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TFS.includes('4h') ? '4h' : TFS[0];
  function renderTabs() {
    $('#tabs').innerHTML = TFS.map((tf) => `<button type="button" role="tab" aria-selected="${tf === current}" data-tf="${tf}">${tfLabel(tf)}</button>`).join('');
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tf]');
    if (!b) return;
    current = b.dataset.tf;
    history.replaceState(null, '', '#' + current);
    renderTabs();
    renderDetail();
  });

  // ---------------- charts ----------------
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function equityChart(box, series, t0, stepMs) {
    const draw = () => {
      const W = Math.max(300, box.clientWidth), H = Math.max(220, box.clientHeight);
      box.innerHTML = '';
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Out-of-sample equity curves' });
      const tipEl = document.createElement('div');
      tipEl.className = 'fc-tip';
      tipEl.hidden = true;
      box.append(svg, tipEl);
      const m = { top: 12, right: 70, bottom: 24, left: 6 };
      const n = Math.max(...series.map((s) => s.values.length));
      let lo = Infinity, hi = -Infinity;
      series.forEach((s) => s.values.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
      lo = Math.min(lo, 1) * 0.96;
      hi = Math.max(hi, 1) * 1.04;
      const L = Math.log;
      const x = (i) => m.left + (i / (n - 1)) * (W - m.left - m.right);
      const y = (v) => m.top + (1 - (L(v) - L(lo)) / (L(hi) - L(lo))) * (H - m.top - m.bottom);
      [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8].filter((v) => v > lo && v < hi).forEach((v) => {
        svgEl('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), class: v === 1 ? 'pc-base' : 'pc-grid' }, svg);
        svgEl('text', { x: W - m.right + 8, y: y(v) + 3.5, class: 'pc-tick' }, svg).textContent = pct(v - 1, 0);
      });
      for (let j = 0; j <= 4; j++) {
        const i = Math.round((j * (n - 1)) / 4);
        svgEl('text', { x: x(i), y: H - 6, class: 'pc-tick', 'text-anchor': j === 0 ? 'start' : j === 4 ? 'end' : 'middle' }, svg).textContent =
          new Date(t0 + i * stepMs).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      }
      series.slice().reverse().forEach((s) => {
        svgEl('polyline', { points: s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: 'pc-line', stroke: s.color }, svg);
      });
      const hit = svgEl('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, class: 'pc-hit' }, svg);
      const cross = svgEl('line', { y1: m.top, y2: H - m.bottom, class: 'pc-cross', visibility: 'hidden' }, svg);
      const dots = series.map((s) => svgEl('circle', { r: 4, fill: s.color, class: 'pc-dot', visibility: 'hidden' }, svg));
      hit.addEventListener('pointermove', (ev) => {
        const r = svg.getBoundingClientRect(), sc = W / r.width;
        const i = Math.max(0, Math.min(n - 1, Math.round((((ev.clientX - r.left) * sc - m.left) / (W - m.left - m.right)) * (n - 1))));
        cross.setAttribute('x1', x(i));
        cross.setAttribute('x2', x(i));
        cross.setAttribute('visibility', 'visible');
        series.forEach((s, k) => {
          dots[k].setAttribute('cx', x(i));
          dots[k].setAttribute('cy', y(s.values[Math.min(i, s.values.length - 1)]));
          dots[k].setAttribute('visibility', 'visible');
        });
        tipEl.innerHTML = `<b>${new Date(t0 + i * stepMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</b><br>` +
          series.map((s) => `<span style="color:${s.color}">●</span> ${s.label}: ${pct(s.values[Math.min(i, s.values.length - 1)] - 1)}`).join('<br>');
        tipEl.hidden = false;
        const cx = x(i) / sc, tw = tipEl.offsetWidth;
        tipEl.style.left = (cx + 14 + tw > r.width ? cx - tw - 14 : cx + 14) + 'px';
        tipEl.style.top = '8px';
      });
      hit.addEventListener('pointerleave', () => {
        tipEl.hidden = true;
        cross.setAttribute('visibility', 'hidden');
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      });
    };
    draw();
    if (window.ResizeObserver) {
      let w = box.clientWidth;
      new ResizeObserver(() => { if (Math.abs(box.clientWidth - w) > 2) { w = box.clientWidth; draw(); } }).observe(box);
    }
  }

  function calibrationSvg(sel, hold) {
    const S = 260, pad = 34, lo = 0.35, hi = 0.65;
    const sc = (v) => pad + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (S - pad - 8);
    const yy = (v) => S - sc(v);
    const pts = (arr, color) => arr.map((b) => `<circle cx="${sc(b.predicted).toFixed(1)}" cy="${(S - sc(b.actual) + pad - 8).toFixed(1)}" r="${Math.max(3, Math.min(9, Math.sqrt(b.n) / 12)).toFixed(1)}" fill="${color}" fill-opacity=".85" stroke="#0d1119" stroke-width="1.5"><title>Predicted ${pctAbs(b.predicted)} → actual ${pctAbs(b.actual)} (${b.n.toLocaleString()} predictions)</title></circle>`).join('');
    const ticks = [0.4, 0.5, 0.6].map((v) => `<text x="${sc(v)}" y="${S - 10}" text-anchor="middle" class="pc-tick">${v * 100}%</text><text x="${pad - 6}" y="${(S - sc(v) + pad - 8 + 3.5).toFixed(1)}" text-anchor="end" class="pc-tick">${v * 100}%</text>`).join('');
    return `<svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:300px;display:block;margin:0 auto" role="img" aria-label="Calibration: predicted vs actual chance of a rise">
      <rect x="${pad}" y="${pad - 8 + 0}" width="${S - pad - 8}" height="${S - pad - 8}" fill="rgba(255,255,255,.02)" rx="6"/>
      <line x1="${sc(lo)}" y1="${(S - sc(lo) + pad - 8).toFixed(1)}" x2="${sc(hi)}" y2="${(S - sc(hi) + pad - 8).toFixed(1)}" stroke="rgba(255,255,255,.25)" stroke-dasharray="3 4"/>
      ${ticks}${pts(sel, COLORS.bh)}${pts(hold, '#818cf8')}
    </svg>`;
    void yy;
  }

  // ---------------- detail ----------------
  function renderDetail() {
    const r = R.timeframes[current];
    const bh = r.buyHold;
    const hPerp = r.chosen.perp.H, hSpot = r.chosen.spot.H;
    const q = r.quality[hPerp] || r.quality[hSpot];
    const qH = r.quality[hPerp] ? hPerp : hSpot;
    const cone = r.cone[qH];
    const stat = (k, v, s, t) => `<div class="stat"><div class="k">${k}${t ? ' ' + tip(t) : ''}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    const coinRows = (venue) => r.chosen[venue].perCoin.map((p) => {
      const h = p.holdout, b = p.buyHold || {};
      return `<tr><td><span class="coinname">${p.symbol.replace('USDT', '')}</span></td><td><span class="badge ${p.verdict}">${BADGE[p.verdict]}</span></td>
        <td class="${h.totalReturn >= 0 ? 'up' : 'down'}">${pct(h.totalReturn, 0)}</td><td>${pct(b.totalReturn, 0)}</td><td>${num(h.sharpe)}</td><td>${num(b.sharpe)}</td>
        <td>${pct(h.maxDD, 0)}</td><td>${pctAbs(h.winRate, 0)}</td><td>${h.trades}</td></tr>`;
    }).join('');

    const variantRows = r.variants.map((v) => {
      const chosen = r.chosen[v.venue].H === v.H && r.chosen[v.venue].tau === v.tau;
      return `<tr class="${chosen ? 'chosen' : ''}"><td>${v.venue === 'spot' ? 'Spot' : 'Futures'}${chosen ? ' ✓' : ''}</td><td>${horizon(current, v.H)}</td><td>${(v.tau * 100).toFixed(0)} pts</td>
        <td>${num(v.selection.sharpe)}</td><td>${v.selection.trades.toLocaleString()}</td><td class="${v.holdout.sharpe >= 0 ? 'up' : 'down'}">${num(v.holdout.sharpe)}</td><td>${pct(v.holdout.totalReturn, 0)}</td></tr>`;
    }).join('');

    $('#detail').innerHTML = `
      <div class="grid2">
        <section class="card panel">
          <h3>Equity on unseen data</h3><div class="sub">$1 split across 12 coins · ${date(r.windows.holdoutStart)} → ${date(r.windows.end)} · after fees · log scale</div>
          <div class="legend-row"><span><i style="background:${COLORS.spot}"></i>Model, spot</span><span><i style="background:${COLORS.perp}"></i>Model, futures</span><span><i style="background:${COLORS.bh}"></i>Buy &amp; hold</span></div>
          <div class="chart-box" id="eq-box"></div>
        </section>
        <section class="card panel">
          <h3>Prediction quality</h3><div class="sub">${horizon(current, qH)} direction calls, unseen data</div>
          <div class="metrics">
            ${stat('Accuracy', pctAbs(q.holdout.accuracy), `majority guess ${pctAbs(q.holdout.alwaysMajorityAccuracy)}`, 'Share of predictions where the more-likely direction was right.')}
            ${stat('AUC', num(q.holdout.auc, 3), '0.500 = coin flip', 'How well the probabilities rank ups above downs. 0.5 means no skill, 1.0 is perfect.')}
            ${stat('Brier score', num(q.holdout.brier, 4), `no-skill ${num(q.holdout.brierBaseline, 4)}`, 'Average squared error of the probabilities. Lower is better; it must beat the no-skill number to be useful.')}
            ${stat('Predictions', q.holdout.predictions.toLocaleString(), '12 coins', '')}
          </div>
          <h3 style="margin-top:16px">Range accuracy ${tip('How often the price actually ended inside the projected range. Well calibrated means the 50% range holds about half the time and the 80% range about 80%.')}</h3>
          <div class="cov">
            <div class="cov-row"><span>50% range</span><div class="cov-bar"><span style="width:${(cone.holdoutCoverage50 * 100).toFixed(1)}%"></span><em style="left:50%"></em></div><b>${pctAbs(cone.holdoutCoverage50, 0)}</b></div>
            <div class="cov-row"><span>80% range</span><div class="cov-bar"><span style="width:${(cone.holdoutCoverage80 * 100).toFixed(1)}%"></span><em style="left:80%"></em></div><b>${pctAbs(cone.holdoutCoverage80, 0)}</b></div>
          </div>
        </section>
      </div>

      <div class="grid2">
        <section class="card panel">
          <h3>Results by setup</h3><div class="sub">Settings were chosen on ${date(r.windows.oosStart)} → ${date(r.windows.holdoutStart)} only, then frozen</div>
          <div class="table-wrap"><table class="t">
            <thead><tr><th></th><th>Horizon</th><th>Entry</th><th>Return</th><th>Sharpe</th><th>Max DD</th><th>Win rate</th><th>Trades</th><th>Verdict</th></tr></thead>
            <tbody>
              ${VENUES.map((v) => { const c = r.chosen[v]; return `<tr><td>${VENUE_NAME[v]}</td><td>${horizon(current, c.H)}</td><td>±${(c.tau * 100).toFixed(0)} pts</td><td class="${c.holdout.totalReturn >= 0 ? 'up' : 'down'}">${pct(c.holdout.totalReturn, 0)}</td><td>${num(c.holdout.sharpe)}</td><td>${pct(c.holdout.maxDD, 0)}</td><td>${pctAbs(c.holdout.winRate, 0)}</td><td>${c.holdout.trades.toLocaleString()}</td><td><span class="badge ${c.verdict}">${BADGE[c.verdict]}</span></td></tr>`; }).join('')}
              <tr><td>Buy &amp; hold</td><td>—</td><td>—</td><td class="${bh.holdout.totalReturn >= 0 ? 'up' : 'down'}">${pct(bh.holdout.totalReturn, 0)}</td><td>${num(bh.holdout.sharpe)}</td><td>${pct(bh.holdout.maxDD, 0)}</td><td>—</td><td>—</td><td></td></tr>
            </tbody>
          </table></div>
          <p class="note">"Tested edge" requires, on unseen data: Sharpe ≥ 0.75, profit factor ≥ 1.1 and ≥ 90% bootstrap confidence that the return is positive. The bar was set before the results were seen.</p>
        </section>
        <section class="card panel">
          <h3>Are the probabilities honest?</h3><div class="sub">Predicted chance of a rise vs how often it actually rose</div>
          ${calibrationSvg(q.selection.calibration, q.holdout.calibration)}
          <div class="legend-row" style="justify-content:center;margin-top:6px"><span><i style="background:${COLORS.bh}"></i>Selection period</span><span><i style="background:#818cf8"></i>Unseen data</span></div>
          <p class="note">Points on the dashed line mean the probabilities can be taken at face value. Points flattening toward 50% mean the model is over-confident.</p>
        </section>
      </div>

      ${VENUES.map((v) => `<section class="card panel detail-block">
        <h3>Per coin · ${VENUE_NAME[v]}</h3><div class="sub">Unseen data, after fees</div>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>Coin</th><th>Verdict</th><th>Model return</th><th>B&amp;H return</th><th>Model Sharpe</th><th>B&amp;H Sharpe</th><th>Max DD</th><th>Win rate</th><th>Trades</th></tr></thead>
          <tbody>${coinRows(v)}</tbody>
        </table></div>
      </section>`).join('')}

      <section class="card panel detail-block">
        <h3>Every setup tested</h3><div class="sub">All ${r.variants.length} combinations, with the one each market picked highlighted. Picking used the selection-period Sharpe only.</div>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>Market</th><th>Horizon</th><th>Entry threshold</th><th>Selection Sharpe</th><th>Selection trades</th><th>Unseen Sharpe</th><th>Unseen return</th></tr></thead>
          <tbody>${variantRows}</tbody>
        </table></div>
      </section>`;

    const sp = r.chosen.spot.equity, pp = r.chosen.perp.equity, be = bh.equity;
    const stepMs = r.barMs * be.step;
    equityChart($('#eq-box'), [
      { label: 'Model, spot', color: COLORS.spot, values: resample(sp, be.step) },
      { label: 'Model, futures', color: COLORS.perp, values: resample(pp, be.step) },
      { label: 'Buy & hold', color: COLORS.bh, values: be.values },
    ], Date.parse(r.windows.holdoutStart + 'T00:00:00Z'), stepMs);
  }

  // Equity curves share the same bar grid; align step sizes if they differ.
  function resample(eq, step) {
    if (eq.step === step) return eq.values;
    const out = [];
    for (let i = 0; i * step / eq.step < eq.values.length; i++) out.push(eq.values[Math.min(eq.values.length - 1, Math.round((i * step) / eq.step))]);
    return out;
  }

  // ---------------- method ----------------
  const S = R.settings || {};
  $('#method').innerHTML = `
    <h2>How these numbers were produced</h2>
    <ul>
      <li><b>Data.</b> Binance spot candles for ${any.coins.length} coins (${any.coins.map((c) => c.replace('USDT', '')).join(', ')}) since 2019, plus perpetual-futures funding rates.</li>
      <li><b>Model.</b> A logistic-regression classifier that estimates the chance the price is higher a few candles from now. It uses 25 inputs (momentum, trend, RSI, MACD, Bollinger position, volatility, volume, candle shape, Bitcoin’s moves, funding rates, day and hour). One model is trained on all coins together.</li>
      <li><b>Walk-forward.</b> Every week the model is retrained on the trailing window (1H: 180 days, 4H: 365 days, 1D: 730 days) and then predicts the next week. No prediction ever used information from its own future.</li>
      <li><b>Picking settings.</b> Horizon and entry threshold were chosen on ${date(S.oosStart || any.windows.oosStart)} → ${date(S.holdoutStart || any.windows.holdoutStart)}. Everything on this page is measured on ${date(any.windows.holdoutStart)} → today, which played no part in that choice.</li>
      <li><b>Costs.</b> Spot: 0.15% per buy or sell (fee plus slippage), long only. Futures: 0.07% per trade plus actual funding payments, long or short, no leverage.</li>
      <li><b>Price ranges.</b> Based on recent volatility (exponentially weighted), with widths calibrated on the selection period and checked on unseen data.</li>
    </ul>
    <h3>Limitations</h3>
    <ul>
      <li>Past performance does not guarantee future returns. Markets change, and small edges disappear.</li>
      <li>About 2 years of unseen data, 12 large coins, one exchange. All 12 coins still trade today, so collapsed coins aren’t included.</li>
      <li>Fills are assumed at the candle close with fixed slippage. Real fills in fast markets can be worse; taxes aren’t included.</li>
      <li>An earlier version of this project had looked at part of this period (Feb 2025 onward) with a different model. It wasn’t used to tune this one, but it isn’t perfectly blind.</li>
    </ul>`;

  renderTabs();
  renderDetail();
})();
