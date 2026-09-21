/* Plain-language tooltips for `.tip` buttons (hover, keyboard focus or tap). */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});

  function init(dictionary) {
    const tipEl = document.getElementById('tooltip');
    let owner = null, shownAt = 0;
    function show(btn) {
      const text = btn.dataset.tipText || (dictionary || {})[btn.dataset.tip];
      if (!text) return;
      if (owner !== btn) shownAt = Date.now();
      owner = btn;
      tipEl.textContent = text;
      tipEl.hidden = false;
      const r = btn.getBoundingClientRect();
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      let top = r.bottom + 8;
      if (top + th > window.innerHeight - 8) top = r.top - th - 8;
      tipEl.style.left = Math.max(12, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 12)) + 'px';
      tipEl.style.top = Math.max(8, top) + 'px';
    }
    function hide() {
      owner = null;
      tipEl.hidden = true;
    }
    const tipOf = (e) => e.target.closest && e.target.closest('.tip');
    document.addEventListener('mouseover', (e) => { const b = tipOf(e); if (b) show(b); });
    document.addEventListener('mouseout', (e) => { if (tipOf(e)) hide(); });
    document.addEventListener('focusin', (e) => { const b = tipOf(e); if (b) show(b); });
    document.addEventListener('focusout', (e) => { if (tipOf(e)) hide(); });
    document.addEventListener('click', (e) => {
      const b = tipOf(e);
      if (!b) return hide();
      e.preventDefault();
      if (owner === b && !tipEl.hidden && Date.now() - shownAt > 400) hide();
      else show(b);
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
    window.addEventListener('scroll', hide, { passive: true });
  }

  K.tooltips = { init };
})(typeof self !== 'undefined' ? self : this);
