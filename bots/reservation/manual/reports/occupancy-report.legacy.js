'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './occupancy-report.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/reports/occupancy-report.js',
);
