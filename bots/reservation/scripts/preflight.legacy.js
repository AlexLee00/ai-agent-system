'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './preflight.ts', '../../../dist/ts-runtime/bots/reservation/scripts/preflight.js');
