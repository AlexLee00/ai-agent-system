'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-daily-summary.ts',
  '../../../../dist/ts-runtime/bots/reservation/auto/scheduled/pickko-daily-summary.js',
);
