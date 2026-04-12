'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './audit-duplicate-slots.ts', '../../../dist/ts-runtime/bots/reservation/scripts/audit-duplicate-slots.js');
