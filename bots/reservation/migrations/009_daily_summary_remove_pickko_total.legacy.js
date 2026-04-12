'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './009_daily_summary_remove_pickko_total.ts', '../../../dist/ts-runtime/bots/reservation/migrations/009_daily_summary_remove_pickko_total.js');
