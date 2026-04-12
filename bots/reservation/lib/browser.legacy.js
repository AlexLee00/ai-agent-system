'use strict';

const { loadTsModuleWithFallback } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './browser.ts', '../../../dist/ts-runtime/bots/reservation/lib/browser.js');
