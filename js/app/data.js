/*
 * Live market data from Binance public endpoints (no API key):
 * candles + 24h tickers over REST, live prices over WebSocket, funding rates
 * from the USDT-perpetual API.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});

  const COINS = [
    { symbol: 'BTCUSDT', ticker: 'BTC', name: 'Bitcoin' },
    { symbol: 'ETHUSDT', ticker: 'ETH', name: 'Ethereum' },
    { symbol: 'SOLUSDT', ticker: 'SOL', name: 'Solana' },
    { symbol: 'BNBUSDT', ticker: 'BNB', name: 'BNB' },
    { symbol: 'XRPUSDT', ticker: 'XRP', name: 'XRP' },
    { symbol: 'DOGEUSDT', ticker: 'DOGE', name: 'Dogecoin' },
    { symbol: 'ADAUSDT', ticker: 'ADA', name: 'Cardano' },
    { symbol: 'AVAXUSDT', ticker: 'AVAX', name: 'Avalanche' },
    { symbol: 'LINKUSDT', ticker: 'LINK', name: 'Chainlink' },
    { symbol: 'DOTUSDT', ticker: 'DOT', name: 'Polkadot' },
    { symbol: 'LTCUSDT', ticker: 'LTC', name: 'Litecoin' },
    { symbol: 'TRXUSDT', ticker: 'TRX', name: 'TRON' },
  ];

  // `model: true` = the forecast model was trained and tested on this timeframe.
  const INTERVALS = {
    '15m': { id: '15m', label: '15m', ms: 900000, tv: '15', model: false },
    '1h': { id: '1h', label: '1H', ms: 3600000, tv: '60', model: true },
    '4h': { id: '4h', label: '4H', ms: 14400000, tv: '240', model: true },
    '1d': { id: '1d', label: '1D', ms: 86400000, tv: 'D', model: true },
    '1w': { id: '1w', label: '1W', ms: 604800000, tv: 'W', model: false },
  };

  const REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const WS = ['wss://data-stream.binance.vision/stream', 'wss://stream.binance.com:9443/stream'];

  async function getJson(urls, timeout) {
    let lastErr = new Error('Network unavailable');
    for (const url of urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout || 9000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // Returns closed candles plus the still-forming one (never fed to the model).
  async function klines(symbol, interval, limit) {
    const rows = await getJson(REST.map((h) => `${h}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit || 1000}`));
    const now = Date.now();
    const closed = [];
    let forming = null;
    for (const k of rows) {
      const c = [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]];
      if (k[6] < now) closed.push(c);
      else forming = c;
    }
    return { closed, forming };
  }

  async function funding(symbol, limit) {
    try {
      const rows = await getJson([`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit || 100}`]);
      return rows.map((r) => [r.fundingTime, +r.fundingRate]);
    } catch (err) {
      return null;
    }
  }

  async function tickers(symbols) {
    const q = encodeURIComponent(JSON.stringify(symbols));
    const rows = await getJson(REST.map((h) => `${h}/api/v3/ticker/24hr?symbols=${q}`));
    const out = {};
    for (const r of rows) out[r.symbol] = { price: +r.lastPrice, open: +r.openPrice, high: +r.highPrice, low: +r.lowPrice, quoteVolume: +r.quoteVolume };
    return out;
  }

  // Live 24h mini-tickers. Reconnects with backoff, alternating hosts.
  function liveTickers(symbols, onTick, onStatus) {
    let ws = null, attempt = 0, stopped = false;
    const streams = symbols.map((s) => s.toLowerCase() + '@miniTicker').join('/');
    function open() {
      ws = new WebSocket(`${WS[attempt % WS.length]}?streams=${streams}`);
      ws.onopen = () => {
        attempt = 0;
        onStatus && onStatus(true);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data).data;
          onTick({ symbol: m.s, price: +m.c, open: +m.o, high: +m.h, low: +m.l, quoteVolume: +m.q });
        } catch (err) { /* ignore malformed frame */ }
      };
      ws.onclose = () => {
        onStatus && onStatus(false);
        if (stopped) return;
        attempt++;
        setTimeout(open, Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5))));
      };
      ws.onerror = () => ws.close();
    }
    open();
    return { stop() { stopped = true; if (ws) ws.close(); } };
  }

  K.data = { COINS, INTERVALS, klines, funding, tickers, liveTickers };
})(typeof self !== 'undefined' ? self : this);
