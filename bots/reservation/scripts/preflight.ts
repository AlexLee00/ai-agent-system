#!/usr/bin/env node
'use strict';

/**
 * scripts/preflight.ts — 스카봇 시작 전 체크 래퍼
 *
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/preflight.js          → 2중 (Node.js 프리플라이트)
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/preflight.js --conn   → 2중 + 3중 (연결성 포함)
 *
 * 종료 코드: 0 = 통과, 1 = 실패
 *
 * start-ops.sh 에서 호출됨.
 */

const args = process.argv.slice(2);
const withConn = args.includes('--conn');

const { preflightSystemCheck, preflightConnCheck } = require('../lib/health');
const { buildReservationCliInsight } = require('../lib/cli-insight');

function buildPreflightFallback({ withConn: includeConn = false, kind = 'success' } = {}) {
  if (kind === 'failure') {
    return `스카 preflight가 실패해 ${includeConn ? '연결성 포함' : '시스템'} 기본 점검 항목을 먼저 확인하는 것이 좋습니다.`;
  }
  return `스카 preflight는 ${includeConn ? '연결성 포함' : '시스템'} 점검 기준으로 통과했습니다.`;
}

async function run() {
  await preflightSystemCheck();
  if (withConn) await preflightConnCheck();
}

run()
  .then(async () => {
    const aiSummary = await buildReservationCliInsight({
      bot: 'reservation-preflight',
      requestType: 'reservation-preflight',
      title: '예약 preflight 점검 요약',
      data: {
        withConn,
        status: 'success',
      },
      fallback: buildPreflightFallback({ withConn, kind: 'success' }),
    }).catch(() => '');
    if (aiSummary) console.log(`🔍 AI: ${aiSummary}`);
    process.exit(0);
  })
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    buildReservationCliInsight({
      bot: 'reservation-preflight',
      requestType: 'reservation-preflight',
      title: '예약 preflight 점검 실패 요약',
      data: {
        withConn,
        status: 'failure',
        error: message,
      },
      fallback: buildPreflightFallback({ withConn, kind: 'failure' }),
    }).then((aiSummary) => {
      if (aiSummary) console.error(`🔍 AI: ${aiSummary}`);
    }).catch(() => {});
    console.error(message);
    process.exit(1);
  });
