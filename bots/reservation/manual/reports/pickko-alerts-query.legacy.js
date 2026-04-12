'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-alerts-query.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-query.js',
);
