'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './args.ts', '../../../dist/ts-runtime/bots/reservation/lib/args.js');
