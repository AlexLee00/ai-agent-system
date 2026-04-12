'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './export-ska-sales-csv.ts', '../../../dist/ts-runtime/bots/reservation/scripts/export-ska-sales-csv.js');
