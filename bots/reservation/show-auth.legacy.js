'use strict';

const { loadTsModuleWithFallback } = require('./lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './show-auth.ts', '../../dist/ts-runtime/bots/reservation/show-auth.js');
