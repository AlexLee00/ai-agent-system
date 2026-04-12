'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-stats-cmd.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/reports/pickko-stats-cmd.js',
);
