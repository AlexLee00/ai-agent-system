'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './check-naver.ts', '../../../dist/ts-runtime/bots/reservation/src/check-naver.js');
