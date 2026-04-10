const loaded = await import('./domestic.legacy.js');

export const runDomesticCycle = loaded.runDomesticCycle;
export const runDomesticResearchCycle = loaded.runDomesticResearchCycle;
export default loaded.default ?? loaded;
