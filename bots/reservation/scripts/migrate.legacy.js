'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './migrate.ts', '../../../dist/ts-runtime/bots/reservation/scripts/migrate.js');
