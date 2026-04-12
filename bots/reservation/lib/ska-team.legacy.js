'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './ska-team.ts', '../../../dist/ts-runtime/bots/reservation/lib/ska-team.js');
