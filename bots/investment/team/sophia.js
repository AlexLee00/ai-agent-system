const loaded = await import('./sophia.legacy.js');

export const analyzeSentiment = loaded.analyzeSentiment;
export const combineSentiment = loaded.combineSentiment;
export default loaded.default ?? loaded;
