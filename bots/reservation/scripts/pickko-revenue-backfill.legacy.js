'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './pickko-revenue-backfill.ts', '../../../dist/ts-runtime/bots/reservation/scripts/pickko-revenue-backfill.js');
