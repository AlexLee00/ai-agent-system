'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './005_pickko_order_raw.ts', '../../../dist/ts-runtime/bots/reservation/migrations/005_pickko_order_raw.js');
