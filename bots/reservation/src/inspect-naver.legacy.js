'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './inspect-naver.ts', '../../../dist/ts-runtime/bots/reservation/src/inspect-naver.js');
