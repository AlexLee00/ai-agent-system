'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './telegram.ts', '../../../dist/ts-runtime/bots/reservation/lib/telegram.js');
