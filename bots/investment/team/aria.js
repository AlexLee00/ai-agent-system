const loaded = await import('./aria.legacy.js');

export const analyzeCryptoMTF = loaded.analyzeCryptoMTF;
export const analyzeKisMTF = loaded.analyzeKisMTF;
export const analyzeKisOverseasMTF = loaded.analyzeKisOverseasMTF;
export default loaded.default ?? loaded;
