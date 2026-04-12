'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './status.ts', '../../../dist/ts-runtime/bots/reservation/lib/status.js');
