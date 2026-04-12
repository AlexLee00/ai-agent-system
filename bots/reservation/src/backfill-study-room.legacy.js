'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './backfill-study-room.ts', '../../../dist/ts-runtime/bots/reservation/src/backfill-study-room.js');
