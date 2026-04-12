'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './alert-client.ts', '../../../dist/ts-runtime/bots/reservation/lib/alert-client.js');
