'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-verify.ts',
  '../../../../dist/ts-runtime/bots/reservation/manual/admin/pickko-verify.js',
);
