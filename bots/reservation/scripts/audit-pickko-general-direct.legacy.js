'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './audit-pickko-general-direct.ts', '../../../dist/ts-runtime/bots/reservation/scripts/audit-pickko-general-direct.js');
