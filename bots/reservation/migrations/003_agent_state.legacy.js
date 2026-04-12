'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './003_agent_state.ts', '../../../dist/ts-runtime/bots/reservation/migrations/003_agent_state.js');
