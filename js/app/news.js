/*
 * Live headlines (via the local server's /api/news RSS proxy) scored with a
 * small keyword lexicon, plus a manual event bias the user can set ("GTA6
 * launch", "ETF decision"...). Together they form the news tilt, which is
 * layered on top of the tested formula and clearly marked as untested.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const BULL = ['surge', 'surges', 'surging', 'soar', 'soars', 'rally', 'rallies', 'rallying', 'record high', 'all-time high', 'ath', 'approve', 'approves', 'approved', 'approval', 'adopt', 'adopts', 'adoption', 'bullish', 'gain', 'gains', 'jump', 'jumps', 'breakout', 'breaks out', 'inflow', 'inflows', 'launch', 'launches', 'partnership', 'partners with', 'upgrade', 'accumulate', 'accumulating', 'buys', 'buying', 'etf', 'institutional', 'rate cut', 'cuts rates', 'cut rates', 'stimulus', 'recover', 'recovers', 'recovery', 'rebound', 'rebounds', 'climb', 'climbs', 'optimism', 'optimistic', 'reserve', 'treasury buys', 'tops', 'milestone', 'boost', 'boosts'];
  const BEAR = ['crash', 'crashes', 'plunge', 'plunges', 'hack', 'hacked', 'exploit', 'exploited', 'ban', 'bans', 'banned', 'lawsuit', 'sues', 'sued', 'charges', 'charged', 'outflow', 'outflows', 'dump', 'dumps', 'bearish', 'fear', 'fears', 'liquidation', 'liquidations', 'liquidated', 'delist', 'delists', 'halt', 'halts', 'halted', 'fraud', 'bankrupt', 'bankruptcy', 'collapse', 'collapses', 'sell-off', 'selloff', 'slump', 'slumps', 'tumble', 'tumbles', 'drop', 'drops', 'falls', 'fell', 'warning', 'warns', 'probe', 'investigation', 'rate hike', 'hikes rates', 'inflation', 'tariff', 'tariffs', 'loses', 'loss', 'losses', 'scam', 'rug pull', 'sinks', 'slides', 'dips', 'crackdown', 'seize', 'seized', 'shutdown', 'outage', 'breach', 'penalty', 'fine', 'fined'];
  const COIN_WORDS = {
    BTCUSDT: ['bitcoin', 'btc'], ETHUSDT: ['ethereum', 'ether', 'eth'], SOLUSDT: ['solana', 'sol'], BNBUSDT: ['bnb', 'binance coin'],
    XRPUSDT: ['xrp', 'ripple'], DOGEUSDT: ['dogecoin', 'doge'], ADAUSDT: ['cardano', 'ada'], AVAXUSDT: ['avalanche', 'avax'],
    LINKUSDT: ['chainlink', 'link'], DOTUSDT: ['polkadot', 'dot'], LTCUSDT: ['litecoin', 'ltc'], TRXUSDT: ['tron', 'trx'],
  };
  const rx = (words) => new RegExp('\\b(' + words.map((w) => w.replace(/[-\s]/g, '[-\\s]')).join('|') + ')\\b', 'i');
  const RX_BULL = rx(BULL), RX_BEAR = rx(BEAR);
  const RX_COIN = Object.fromEntries(Object.entries(COIN_WORDS).map(([s, w]) => [s, rx(w)]));
  const BIAS_LEVELS = [
    { value: -1.5, label: 'Strongly bearish' }, { value: -0.75, label: 'Bearish' }, { value: 0, label: 'No event bias' },
    { value: 0.75, label: 'Bullish' }, { value: 1.5, label: 'Strongly bullish' },
  ];
  const HEADLINE_CAP = 0.75;
  let cache = null;

  async function fetchNews() {
    if (cache && Date.now() - cache.at < 300000) return cache.data;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch('api/news', { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      cache = { at: Date.now(), data };
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  const count = (re, text) => (text.match(new RegExp(re.source, 'gi')) || []).length;

  // Each headline: sentiment -1..+1, relevance to the coin, freshness decay (12h half-life-ish).
  function score(items, symbol, now) {
    now = now || Date.now();
    const scored = (items || []).map((it) => {
      const text = it.title || '';
      const raw = count(RX_BULL, text) - count(RX_BEAR, text);
      const sent = Math.max(-1, Math.min(1, raw / 2));
      const mine = RX_COIN[symbol] && RX_COIN[symbol].test(text);
      const other = !mine && Object.entries(RX_COIN).some(([s, re]) => s !== symbol && re.test(text));
      const relevance = mine ? 1 : other ? 0.1 : 0.4;
      const ageH = Math.max(0, (now - (it.published || now)) / 3600000);
      const decay = Math.exp(-ageH / 12);
      return Object.assign({}, it, { sent, relevance, ageH, weight: relevance * decay, contribution: sent * relevance * decay });
    });
    let sum = 0;
    for (const s of scored) sum += s.contribution;
    const tilt = Math.max(-1, Math.min(1, sum / 2.5)) * HEADLINE_CAP;
    scored.sort((a, b) => b.relevance - a.relevance || a.ageH - b.ageH);
    return { tilt, scored, bullish: scored.filter((s) => s.sent > 0).length, bearish: scored.filter((s) => s.sent < 0).length };
  }

  function loadBias() {
    try { return JSON.parse(localStorage.getItem('terminal.eventBias') || '{}'); } catch (e) { return {}; }
  }
  function getBias(symbol) {
    const all = loadBias();
    return all[symbol] || all['*'] || { value: 0, note: '' };
  }
  function setBias(symbol, value, note) {
    const all = loadBias();
    if (!value && !note) delete all[symbol]; else all[symbol] = { value: +value || 0, note: (note || '').slice(0, 80) };
    try { localStorage.setItem('terminal.eventBias', JSON.stringify(all)); } catch (e) { /* blocked */ }
  }

  K.news = { fetchNews, score, getBias, setBias, BIAS_LEVELS, HEADLINE_CAP };
})(typeof self !== 'undefined' ? self : this);
