'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './health-check.ts', '../../../dist/ts-runtime/bots/reservation/scripts/health-check.js');
