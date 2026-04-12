'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './ska-read-service.ts', '../../../dist/ts-runtime/bots/reservation/lib/ska-read-service.js');
