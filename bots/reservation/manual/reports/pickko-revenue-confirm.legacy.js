'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-revenue-confirm.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/reports/pickko-revenue-confirm.js',
);
