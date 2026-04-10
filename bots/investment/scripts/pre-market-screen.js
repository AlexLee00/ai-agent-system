const loaded = await import('./pre-market-screen.legacy.js');

export const loadPreScreened = loaded.loadPreScreened;
export const loadPreScreenedFallback = loaded.loadPreScreenedFallback;
export const savePreScreened = loaded.savePreScreened;
export const saveResearchWatchlist = loaded.saveResearchWatchlist;
export default loaded.default ?? loaded;
