// @ts-nocheck
function keyForTrade(trade = {}) {
  const market = trade.market || trade.exchange || 'unknown_market';
  const strategy = trade.strategy || trade.strategyRoute || trade.reasonCode || 'unknown_strategy';
  const outcome = Number(trade.pnl ?? trade.pnlPct ?? trade.realizedPnlPct ?? 0) >= 0 ? 'win' : 'loss';
  return `${market}:${strategy}:${outcome}`;
}

export function clusterTradePatterns(trades = []) {
  const clusters = {};
  for (const trade of trades) {
    const key = keyForTrade(trade);
    clusters[key] ||= { key, count: 0, symbols: new Set(), pnlSum: 0 };
    clusters[key].count += 1;
    clusters[key].symbols.add(trade.symbol || 'unknown');
    clusters[key].pnlSum += Number(trade.pnl ?? trade.pnlPct ?? trade.realizedPnlPct ?? 0) || 0;
  }
  return Object.values(clusters)
    .map((cluster) => ({
      key: cluster.key,
      count: cluster.count,
      symbols: Array.from(cluster.symbols),
      avgPnl: cluster.count > 0 ? cluster.pnlSum / cluster.count : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

export default { clusterTradePatterns };
