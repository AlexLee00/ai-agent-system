'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './study-room-pricing.ts', '../../../dist/ts-runtime/bots/reservation/lib/study-room-pricing.js');
