'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './formatting.ts', '../../../dist/ts-runtime/bots/reservation/lib/formatting.js');
