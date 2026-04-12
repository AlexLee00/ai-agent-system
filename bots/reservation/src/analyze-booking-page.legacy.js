'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './analyze-booking-page.ts', '../../../dist/ts-runtime/bots/reservation/src/analyze-booking-page.js');
