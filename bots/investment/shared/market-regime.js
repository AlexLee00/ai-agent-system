const loaded = await import('./market-regime.legacy.js');

export const getMarketRegime = loaded.getMarketRegime;
export const formatMarketRegime = loaded.formatMarketRegime;
export default loaded.default ?? loaded;
