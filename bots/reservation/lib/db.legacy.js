'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './db.ts',
  '../../../dist/ts-runtime/bots/reservation/lib/db.js',
);
