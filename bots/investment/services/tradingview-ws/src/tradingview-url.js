const DEFAULT_TRADINGVIEW_WS_BASE = 'wss://data.tradingview.com/socket.io/websocket';

export function buildDefaultTradingViewWsUrl() {
  const url = new URL(DEFAULT_TRADINGVIEW_WS_BASE);
  url.searchParams.set('from', 'chart/');
  url.searchParams.set('type', 'chart');
  return url.toString();
}

export function resolveTradingViewWsUrl(env = process.env) {
  const override = String(env?.TV_WS_URL || '').trim();
  if (override) return override;
  return buildDefaultTradingViewWsUrl();
}
