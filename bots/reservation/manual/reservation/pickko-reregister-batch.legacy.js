'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './pickko-reregister-batch.ts', '../../../../dist/ts-runtime/bots/reservation/manual/reservation/pickko-reregister-batch.js');
