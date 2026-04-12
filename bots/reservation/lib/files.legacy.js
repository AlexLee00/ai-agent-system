'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './files.ts', '../../../dist/ts-runtime/bots/reservation/lib/files.js');
