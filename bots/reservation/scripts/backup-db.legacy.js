'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './backup-db.ts', '../../../dist/ts-runtime/bots/reservation/scripts/backup-db.js');
