const loaded = await import('./investment-profile.legacy.js');

export const getInvestmentProfile = loaded.getInvestmentProfile;
export default loaded.default ?? loaded;
