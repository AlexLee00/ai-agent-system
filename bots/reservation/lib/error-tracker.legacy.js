'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './error-tracker.ts', '../../../dist/ts-runtime/bots/reservation/lib/error-tracker.js');
