'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './ska.ts', '../../../dist/ts-runtime/bots/reservation/src/ska.js');
