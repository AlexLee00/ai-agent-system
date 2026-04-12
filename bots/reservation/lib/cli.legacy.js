'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './cli.ts', '../../../dist/ts-runtime/bots/reservation/lib/cli.js');
