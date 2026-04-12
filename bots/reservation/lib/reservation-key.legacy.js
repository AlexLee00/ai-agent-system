'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './reservation-key.ts', '../../../dist/ts-runtime/bots/reservation/lib/reservation-key.js');
