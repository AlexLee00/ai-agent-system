const loaded = await import('./hermes.legacy.js');

export const analyzeNews = loaded.analyzeNews;
export default loaded.default ?? loaded;
