'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './naver-monitor.ts',
  '../../../../dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js',
);
