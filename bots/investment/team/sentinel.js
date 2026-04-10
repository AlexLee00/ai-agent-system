const loaded = await import('./sentinel.legacy.js');

export const combineSentinelResult = loaded.combineSentinelResult;
export const analyze = loaded.analyze;
export default loaded.default ?? loaded;
