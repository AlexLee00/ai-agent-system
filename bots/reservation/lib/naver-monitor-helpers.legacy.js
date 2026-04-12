'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './naver-monitor-helpers.ts', '../../../dist/ts-runtime/bots/reservation/lib/naver-monitor-helpers.js');
