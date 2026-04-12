'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './runtime-config.ts', '../../../dist/ts-runtime/bots/reservation/lib/runtime-config.js');
