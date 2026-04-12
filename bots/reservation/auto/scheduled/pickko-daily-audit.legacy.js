'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-daily-audit.ts',
  '../../../../dist/ts-runtime/bots/reservation/auto/scheduled/pickko-daily-audit.js',
);
