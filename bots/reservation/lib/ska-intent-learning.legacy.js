'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './ska-intent-learning.ts', '../../../dist/ts-runtime/bots/reservation/lib/ska-intent-learning.js');
