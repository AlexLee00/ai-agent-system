'use strict';

const { loadTsModuleWithFallback } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModuleWithFallback(__dirname, './init-naver-booking-session.ts', '../../../dist/ts-runtime/bots/reservation/src/init-naver-booking-session.js');
