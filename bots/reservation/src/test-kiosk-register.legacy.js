'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './test-kiosk-register.ts', '../../../dist/ts-runtime/bots/reservation/src/test-kiosk-register.js');
