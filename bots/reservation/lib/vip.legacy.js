'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './vip.ts',
  '../../../dist/ts-runtime/bots/reservation/lib/vip.js',
);
