'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './log-rotate.ts', '../../../dist/ts-runtime/bots/reservation/scripts/log-rotate.js');
