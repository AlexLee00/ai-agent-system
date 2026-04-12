'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './check-n8n-command-path.ts', '../../../dist/ts-runtime/bots/reservation/scripts/check-n8n-command-path.js');
