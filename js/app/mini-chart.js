/*
 * Built-in candlestick chart. Draws from the Binance candles the page already
 * fetches, so it works where the TradingView embed is blocked (mobile content
 * blockers, strict tracking protection) and needs no third party at all.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }

  // d: { candles: [[t,o,h,l,c,v]], fmt, timeLabel, levels: {entry,stop,target}|null, title }
  function draw(container, d) {
    container.__mc = d;
    render(container);
    if (!container.__mcRo && root.ResizeObserver) {
      let w = container.clientWidth;
      container.__mcRo = new ResizeObserver(() => {
        if (container.__mc && Math.abs(container.clientWidth - w) > 2) {
          w = container.clientWidth;
          render(container);
        }
      });
      container.__mcRo.observe(container);
    }
  }

  function render(container) {
    const d = container.__mc;
    if (!d || !d.candles.length) return;
    const W = Math.max(280, Math.round(container.clientWidth));
    const H = Math.max(220, Math.round(container.clientHeight));
    const m = { top: 10, right: 62, bottom: 20, left: 6 };
    const volH = Math.round((H - m.top - m.bottom) * 0.18);
    const priceH = H - m.top - m.bottom - volH - 6;
    const n = d.candles.length;
    const plotW = W - m.left - m.right;
    const xw = plotW / n;
    const x = (i) => m.left + xw * (i + 0.5);

    let lo = Infinity, hi = -Infinity, vMax = 0;
    for (const c of d.candles) {
      lo = Math.min(lo, c[3]);
      hi = Math.max(hi, c[2]);
      vMax = Math.max(vMax, c[5] || 0);
    }
    const lv = d.levels;
    if (lv) {
      // keep the trade levels on screen, but never let them squash the candles
      const span = hi - lo;
      for (const p of [lv.stop, lv.target]) {
        if (Number.isFinite(p) && p > lo - span * 0.6 && p < hi + span * 0.6) {
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
      }
    }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * priceH;
    const vy = (v) => m.top + priceH + 6 + volH - (vMax ? (v / vMax) * volH : 0);

    container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', role: 'img', 'aria-label': d.title || 'Price chart' }, container);

    niceTicks(lo, hi, 5).forEach((v) => {
      const yy = y(v);
      if (yy < m.top || yy > m.top + priceH) return;
      el('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, class: 'mc-grid' }, svg);
      el('text', { x: W - m.right + 5, y: yy + 3.5, class: 'mc-tick' }, svg).textContent = d.fmt(v);
    });

    const bw = Math.max(1, Math.min(9, xw * 0.66));
    d.candles.forEach((c, i) => {
      const up = c[4] >= c[1], cls = up ? 'mc-up' : 'mc-down', xx = x(i);
      el('line', { x1: xx, x2: xx, y1: y(c[2]), y2: y(c[3]), class: `${cls} mc-wick` }, svg);
      const top = y(Math.max(c[1], c[4])), bot = y(Math.min(c[1], c[4]));
      el('rect', { x: xx - bw / 2, y: top, width: bw, height: Math.max(1, bot - top), class: cls }, svg);
      if (vMax) el('rect', { x: xx - bw / 2, y: vy(c[5] || 0), width: bw, height: Math.max(0, m.top + priceH + 6 + volH - vy(c[5] || 0)), class: `${cls} mc-vol` }, svg);
    });

    // Trade levels from the current signal.
    if (lv) {
      const lines = [
        { p: lv.stop, cls: 'mc-stop', label: 'stop' },
        { p: lv.target, cls: 'mc-target', label: 'target' },
        { p: lv.entry, cls: 'mc-entry', label: 'entry' },
      ];
      for (const L of lines) {
        if (!Number.isFinite(L.p)) continue;
        const yy = y(L.p);
        if (yy < m.top - 1 || yy > m.top + priceH + 1) continue;
        el('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, class: L.cls }, svg);
        el('text', { x: m.left + 4, y: yy - 3, class: `mc-lab ${L.cls}` }, svg).textContent = L.label;
      }
    }

    // Last price tag.
    const last = d.candles[n - 1][4], ly = y(last);
    const up = d.candles[n - 1][4] >= d.candles[n - 1][1];
    el('line', { x1: m.left, x2: W - m.right, y1: ly, y2: ly, class: 'mc-last' }, svg);
    const g = el('g', { class: `mc-tag ${up ? 'up' : 'down'}` }, svg);
    el('rect', { x: W - m.right + 2, y: ly - 8, width: m.right - 4, height: 16, rx: 3 }, g);
    el('text', { x: W - m.right + 5, y: ly + 3.5 }, g).textContent = d.fmt(last);

    const labels = Math.max(2, Math.min(5, Math.floor(plotW / 90)));
    for (let j = 0; j < labels; j++) {
      const i = Math.round((j * (n - 1)) / (labels - 1));
      el('text', { x: x(i), y: H - 5, class: 'mc-tick', 'text-anchor': j === 0 ? 'start' : j === labels - 1 ? 'end' : 'middle' }, svg).textContent = d.timeLabel(d.candles[i][0]);
    }
  }

  K.miniChart = { draw };
})(typeof self !== 'undefined' ? self : this);
