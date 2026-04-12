'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './get-naver-html.ts', '../../../dist/ts-runtime/bots/reservation/src/get-naver-html.js');
