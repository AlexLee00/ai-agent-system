'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-pay-scan.ts',
  '../../../../dist/ts-runtime/bots/reservation/auto/scheduled/pickko-pay-scan.js',
);
