'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './validation.ts', '../../../dist/ts-runtime/bots/reservation/lib/validation.js');
