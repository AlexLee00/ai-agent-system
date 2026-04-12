'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './manual-cancellation.ts', '../../../dist/ts-runtime/bots/reservation/lib/manual-cancellation.js');
