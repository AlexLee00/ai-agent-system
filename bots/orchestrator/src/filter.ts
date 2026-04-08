const filterModule = require('./filter.js') as typeof import('./filter.js');

export const { processItem, flushAll } = filterModule;
