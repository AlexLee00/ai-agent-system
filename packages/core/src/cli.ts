// @ts-nocheck
'use strict';

/**
 * packages/core/src/cli.js — JSON stdout CLI 헬퍼
 * 모든 봇 CLI 스크립트 공통
 */

function outputResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function fail(message, extra = {}) {
  outputResult({ success: false, message, ...extra });
  process.exit(1);
}

function successResult(message, extra = {}) {
  outputResult({ success: true, message, ...extra });
}

module.exports = { outputResult, fail, successResult };
