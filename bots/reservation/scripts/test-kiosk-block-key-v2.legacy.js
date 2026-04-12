'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './test-kiosk-block-key-v2.ts', '../../../dist/ts-runtime/bots/reservation/scripts/test-kiosk-block-key-v2.js');
