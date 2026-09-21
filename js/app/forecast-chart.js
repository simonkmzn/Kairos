/*
 * Forecast chart: recent candles, the model's position history (background
 * tint), a strip of per-candle "chance up" bars, and the projected 50% / 80%
 * price ranges fanning out to the forecast horizon.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

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

  function update(container, d) {
    container.__d = d;
    if (!container.__ro && root.ResizeObserver) {
      let lastW = 0;
      container.__ro = new ResizeObserver(() => {
        if (container.__d && Math.abs(container.clientWidth - lastW) > 2) {
          lastW = container.clientWidth;
          render(container);
        }
      });
      container.__ro.observe(container);
    }
    render(container);
  }

  function render(container) {
    const d = container.__d;
    const W = Math.max(300, Math.round(container.clientWidth)), Hh = Math.max(240, Math.round(container.clientHeight));
    container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': d.aria || 'Forecast chart' });
    const tip = document.createElement('div');
    tip.className = 'fc-tip';
    tip.hidden = true;
    container.appendChild(svg);
    container.appendChild(tip);

    const id = ++uid;
    const defs = el('defs', {}, svg);
    const grad = (name, a0, a1) => {
      const g = el('linearGradient', { id: `${name}${id}`, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
      el('stop', { offset: 0, 'stop-color': '#818cf8', 'stop-opacity': a0 }, g);
      el('stop', { offset: 1, 'stop-color': '#a78bfa', 'stop-opacity': a1 }, g);
    };
    grad('g80-', 0.06, 0.22);
    grad('g50-', 0.16, 0.45);

    const N = d.candles.length, F = d.cone.length - 1;
    const m = { top: 14, right: 84, bottom: 22, left: 6 };
    const stripH = 44, gap = 14;
    const plotW = W - m.left - m.right;
    const priceH = Hh - m.top - m.bottom - stripH - gap;
    // The forecast always gets at least 22% of the width, so short horizons stay readable.
    const fcW = Math.max((plotW / (N + F + 1)) * (F + 0.5), plotW * 0.22);
    const xw = (plotW - fcW) / N;
    const xNow = m.left + xw * (N - 0.5);
    const fcStep = (fcW - 10) / F;
    // i <= N-1: candle i; i > N-1: forecast step h = i - (N-1).
    const x = (i) => (i <= N - 1 ? m.left + xw * (i + 0.5) : xNow + (i - (N - 1)) * fcStep);

    let lo = Infinity, hi = -Infinity;
    for (const c of d.candles) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
    for (const c of d.cone) { lo = Math.min(lo, c.lo80); hi = Math.max(hi, c.hi80); }
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
    const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * priceH;

    // Model position history as background tint.
    let run = 0;
    for (let i = 1; i <= N; i++) {
      if (i === N || d.positions[i] !== d.positions[run]) {
        const p = d.positions[run];
        if (p) el('rect', { x: x(run) - xw / 2, y: m.top, width: xw * (i - run), height: priceH, class: p > 0 ? 'fc-pos-long' : 'fc-pos-short' }, svg);
        run = i;
      }
    }

    // Forecast zone backdrop.
    el('rect', { x: xNow, y: m.top, width: fcW, height: priceH, class: 'fc-zone' }, svg);

    niceTicks(lo, hi, 5).forEach((v) => {
      const yy = y(v);
      el('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, class: 'fc-grid' }, svg);
      el('text', { x: W - m.right + 8, y: yy + 3.5, class: 'fc-tick' }, svg).textContent = d.fmt(v);
    });

    // Forecast cone.
    const pts = (key) => d.cone.map((c, h) => `${x(N - 1 + h).toFixed(1)},${y(c[key]).toFixed(1)}`);
    el('polygon', { points: pts('hi80').concat(pts('lo80').reverse()).join(' '), fill: `url(#g80-${id})` }, svg);
    el('polygon', { points: pts('hi50').concat(pts('lo50').reverse()).join(' '), fill: `url(#g50-${id})` }, svg);
    el('polyline', { points: pts('mid').join(' '), class: 'fc-mid' }, svg);

    el('line', { x1: xNow, x2: xNow, y1: m.top, y2: m.top + priceH + gap + stripH, class: 'fc-now' }, svg);
    el('text', { x: xNow + 8, y: m.top + 12, class: 'fc-now-label' }, svg).textContent = 'FORECAST';

    // Candles.
    const bw = Math.max(1, Math.min(9, xw * 0.64));
    d.candles.forEach((c, i) => {
      const cls = c[4] >= c[1] ? 'fc-up' : 'fc-down';
      const xx = x(i);
      el('line', { x1: xx, x2: xx, y1: y(c[2]), y2: y(c[3]), class: `${cls} fc-wick` }, svg);
      const top = y(Math.max(c[1], c[4])), bot = y(Math.min(c[1], c[4]));
      el('rect', { x: xx - bw / 2, y: top, width: bw, height: Math.max(1, bot - top), rx: 1, class: cls }, svg);
    });

    // Right-edge tags: 80% high, middle, 80% low, and the current price.
    const end = d.cone[F];
    const tags = [
      { v: end.hi80, label: d.fmt(end.hi80), cls: '' },
      { v: end.mid, label: d.fmt(end.mid), cls: 'mid' },
      { v: end.lo80, label: d.fmt(end.lo80), cls: '' },
      { v: d.candles[N - 1][4], label: d.fmt(d.candles[N - 1][4]), cls: 'now' },
    ].map((t) => ({ ...t, y: y(t.v) })).sort((a, b) => a.y - b.y);
    for (let j = 1; j < tags.length; j++) if (tags[j].y - tags[j - 1].y < 17) tags[j].y = tags[j - 1].y + 17;
    tags.forEach((t) => {
      const g = el('g', { class: `fc-tag ${t.cls}` }, svg);
      el('rect', { x: W - m.right + 3, y: t.y - 8, width: m.right - 5, height: 16, rx: 4 }, g);
      el('text', { x: W - m.right + 8, y: t.y + 3.5 }, g).textContent = t.label;
    });

    // Chance-up strip.
    const sy = m.top + priceH + gap, smid = sy + stripH / 2;
    el('rect', { x: m.left, y: sy, width: plotW - fcW, height: stripH, rx: 6, class: 'fc-strip' }, svg);
    el('line', { x1: m.left, x2: xNow, y1: smid, y2: smid, class: 'fc-grid' }, svg);
    const scale = 0.2; // |p - 0.5| of 0.2 fills half the strip
    if (d.tau > 0) {
      const ty = (d.tau / scale) * (stripH / 2);
      el('line', { x1: m.left, x2: xNow, y1: smid - ty, y2: smid - ty, class: 'fc-tau' }, svg);
      el('line', { x1: m.left, x2: xNow, y1: smid + ty, y2: smid + ty, class: 'fc-tau' }, svg);
    }
    d.probs.forEach((p, i) => {
      if (p === null) return;
      const v = Math.max(-1, Math.min(1, (p - 0.5) / scale));
      const h = Math.max(1, Math.abs(v) * (stripH / 2 - 2));
      el('rect', { x: x(i) - bw / 2, y: v >= 0 ? smid - h : smid, width: bw, height: h, rx: 1, class: v >= 0 ? 'fc-p-up' : 'fc-p-down' }, svg);
    });
    const lastP = d.probs[N - 1];
    if (lastP !== null && lastP !== undefined) {
      el('text', { x: xNow + 10, y: smid + 4, class: `fc-pnow ${lastP >= 0.5 ? 'up' : 'down'}` }, svg).textContent = `${(lastP * 100).toFixed(1)}% up now`;
    }
    el('text', { x: W - m.right + 8, y: sy + 10, class: 'fc-tick' }, svg).textContent = '70% up';
    el('text', { x: W - m.right + 8, y: smid + 3.5, class: 'fc-tick' }, svg).textContent = '50%';
    el('text', { x: W - m.right + 8, y: sy + stripH - 3, class: 'fc-tick' }, svg).textContent = '30% up';

    // Time axis.
    const nLabels = Math.max(2, Math.min(5, Math.floor((plotW - fcW) / 130)));
    for (let j = 0; j < nLabels; j++) {
      const i = Math.round((j * (N - 1)) / nLabels);
      el('text', { x: x(i), y: Hh - 5, 'text-anchor': j === 0 ? 'start' : 'middle', class: 'fc-tick' }, svg).textContent = d.timeLabel(d.candles[i][0]);
    }
    el('text', { x: x(N - 1 + F), y: Hh - 5, 'text-anchor': 'end', class: 'fc-tick fc-accent' }, svg).textContent = '+' + d.horizonLabel;

    // Hover.
    const hit = el('rect', { x: m.left, y: m.top, width: plotW, height: priceH + gap + stripH, class: 'fc-hit' }, svg);
    const cross = el('line', { y1: m.top, y2: sy + stripH, class: 'fc-cross', visibility: 'hidden' }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const scaleX = W / r.width;
      const px = (ev.clientX - r.left) * scaleX;
      const i = px <= xNow + xw / 2
        ? Math.max(0, Math.min(N - 1, Math.round((px - m.left) / xw - 0.5)))
        : N - 1 + Math.max(1, Math.min(F, Math.round((px - xNow) / fcStep)));
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      let html;
      if (i < N) {
        const c = d.candles[i], p = d.probs[i], pos = d.positions[i];
        html = `<b>${d.timeLabel(c[0], true)}</b><br>O ${d.fmt(c[1])} · H ${d.fmt(c[2])}<br>L ${d.fmt(c[3])} · C ${d.fmt(c[4])}` +
          `<br>Chance up: ${p === null ? '—' : (p * 100).toFixed(1) + '%'}<br>Model: ${d.positionLabel(pos)}`;
      } else {
        const h = i - (N - 1), c = d.cone[h];
        html = `<b>${h} candle${h === 1 ? '' : 's'} ahead</b><br>80%: ${d.fmt(c.lo80)} – ${d.fmt(c.hi80)}<br>50%: ${d.fmt(c.lo50)} – ${d.fmt(c.hi50)}<br>Middle: ${d.fmt(c.mid)}`;
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const cx = x(i) / scaleX, tw = tip.offsetWidth;
      tip.style.left = (cx + 14 + tw > r.width ? cx - tw - 14 : cx + 14) + 'px';
      tip.style.top = '10px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
    });
  }

  K.forecastChart = { update };
})(typeof self !== 'undefined' ? self : this);
