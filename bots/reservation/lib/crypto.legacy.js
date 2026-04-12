'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './crypto.ts', '../../../dist/ts-runtime/bots/reservation/lib/crypto.js');
