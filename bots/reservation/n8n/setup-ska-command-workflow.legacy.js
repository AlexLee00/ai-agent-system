'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './setup-ska-command-workflow.ts', '../../../dist/ts-runtime/bots/reservation/n8n/setup-ska-command-workflow.js');
