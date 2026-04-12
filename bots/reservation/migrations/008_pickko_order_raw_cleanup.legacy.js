'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './008_pickko_order_raw_cleanup.ts', '../../../dist/ts-runtime/bots/reservation/migrations/008_pickko_order_raw_cleanup.js');
