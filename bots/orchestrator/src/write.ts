const writeModule = require('./write.js') as typeof import('./write.js');

export const { runOnPush, runDaily } = writeModule;
