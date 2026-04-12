'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './manual-batch-reserve.ts', '../../../dist/ts-runtime/bots/reservation/scripts/manual-batch-reserve.js');
