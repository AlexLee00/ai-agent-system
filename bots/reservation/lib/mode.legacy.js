'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './mode.ts', '../../../dist/ts-runtime/bots/reservation/lib/mode.js');
