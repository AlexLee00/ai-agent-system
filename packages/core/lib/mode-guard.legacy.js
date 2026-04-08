'use strict';
/**
 * packages/core/lib/mode-guard.js
 *
 * ⚠️  이 파일은 하위 호환용 래퍼입니다.
 *    실제 구현은 packages/core/lib/env.js 에 있습니다.
 *
 * 기존 코드:
 *   const { runIfOps, isOps } = require('./mode-guard');
 *   → 계속 동작합니다.
 *
 * 신규 코드:
 *   const env = require('./env');
 *   → env.runIfOps, env.IS_OPS, env.PROJECT_ROOT 등 모두 사용 가능.
 */
const env = require('./env');

module.exports = {
  MODE: env.MODE,
  ensureOps: env.ensureOps,
  ensureDev: env.ensureDev,
  isOps: () => env.IS_OPS,
  isDev: () => env.IS_DEV,
  getMode: () => env.MODE,
  runIfOps: env.runIfOps,
};
