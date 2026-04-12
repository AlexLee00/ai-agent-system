'use strict';

const { loadTsModuleWithFallback } = require('../../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './pickko-cancel-cmd.ts', '../../../../dist/ts-runtime/bots/reservation/manual/reservation/pickko-cancel-cmd.js');
