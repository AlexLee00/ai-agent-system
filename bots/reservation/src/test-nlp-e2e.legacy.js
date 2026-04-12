'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './test-nlp-e2e.ts', '../../../dist/ts-runtime/bots/reservation/src/test-nlp-e2e.js');
