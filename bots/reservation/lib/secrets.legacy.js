'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './secrets.ts', '../../../dist/ts-runtime/bots/reservation/lib/secrets.js');
