'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './006_kiosk_block_attempts.ts', '../../../dist/ts-runtime/bots/reservation/migrations/006_kiosk_block_attempts.js');
