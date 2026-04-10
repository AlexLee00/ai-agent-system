const loaded = await import('./crypto.legacy.js');

export const runCryptoCycle = loaded.runCryptoCycle;
export default loaded.default ?? loaded;
