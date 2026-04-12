'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './007_kiosk_block_key_v2.ts', '../../../dist/ts-runtime/bots/reservation/migrations/007_kiosk_block_key_v2.js');
