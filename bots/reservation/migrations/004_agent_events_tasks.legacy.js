'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './004_agent_events_tasks.ts', '../../../dist/ts-runtime/bots/reservation/migrations/004_agent_events_tasks.js');
