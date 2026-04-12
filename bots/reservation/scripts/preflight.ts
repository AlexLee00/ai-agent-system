#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * scripts/preflight.js — 스카봇 시작 전 체크 래퍼
 *
 *   node scripts/preflight.js          → 2중 (Node.js 프리플라이트)
 *   node scripts/preflight.js --conn   → 2중 + 3중 (연결성 포함)
 *
 * 종료 코드: 0 = 통과, 1 = 실패
 *
 * start-ops.sh 에서 호출됨.
 */

const args = process.argv.slice(2);
const withConn = args.includes('--conn');

const { preflightSystemCheck, preflightConnCheck } = require('../lib/health');

async function run() {
  await preflightSystemCheck();
  if (withConn) await preflightConnCheck();
}

run()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.message); process.exit(1); });
