'use strict';

/**
 * lib/cli.js — JSON stdout CLI 헬퍼 (standalone)
 * 신규 봇은 @ai-agent/core 사용. reservation 봇 전용 독립 버전.
 */

function outputResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function fail(message, extra = {}) {
  outputResult({ success: false, message, ...extra });
  process.exit(1);
}

module.exports = { outputResult, fail };
