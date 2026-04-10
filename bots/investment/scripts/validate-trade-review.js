const loaded = await import('./validate-trade-review.legacy.js');

export const validateTradeReview = loaded.validateTradeReview;
export default loaded.default ?? loaded;
