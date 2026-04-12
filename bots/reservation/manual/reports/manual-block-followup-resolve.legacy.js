'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './manual-block-followup-resolve.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/reports/manual-block-followup-resolve.js',
);
