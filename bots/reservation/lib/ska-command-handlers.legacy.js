'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './ska-command-handlers.ts', '../../../dist/ts-runtime/bots/reservation/lib/ska-command-handlers.js');
