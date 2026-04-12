'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(
  __dirname,
  './pickko-kiosk-monitor.ts',
  '../../../../dist/ts-runtime/bots/reservation/auto/monitors/pickko-kiosk-monitor.js',
);
