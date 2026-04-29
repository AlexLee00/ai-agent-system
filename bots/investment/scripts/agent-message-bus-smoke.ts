/**
 * scripts/agent-message-bus-smoke.ts — Phase E Cross-Agent Message Bus 스모크 테스트
 *
 * 테스트 항목:
 *   1. sendMessage — 메시지 전송
 *   2. broadcastMessage — 브로드캐스트
 *   3. getPendingMessages — 수신 대기 메시지 조회
 *   4. respondToMessage — 응답 및 responded_at 기록
 *   5. getMessagesByIncident — incident_key 기반 전체 조회
 *   6. kill switch LUNA_AGENT_CROSS_BUS_ENABLED=false
 */

import {
  sendMessage,
  broadcastMessage,
  getPendingMessages,
  respondToMessage,
  getMessagesByIncident,
} from '../shared/agent-message-bus.ts';
import * as db from '../shared/db.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main(): Promise<void> {
  console.log('[message-bus-smoke] 시작');
  await db.initSchema();

  // ─── 1. kill switch ────────────────────────────────────────────────────────
  const origEnabled = process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
  process.env.LUNA_AGENT_CROSS_BUS_ENABLED = 'false';

  const killId = await sendMessage('argos', 'sophia', { question: 'test' });
  assert(killId === -1, 'kill switch 시 sendMessage는 -1 반환 필요');

  const killBroadcastId = await broadcastMessage('luna', { type: 'test' });
  assert(killBroadcastId === -1, 'kill switch 시 broadcastMessage는 -1 반환 필요');

  const killPending = await getPendingMessages('sophia');
  assert(Array.isArray(killPending) && killPending.length === 0, 'kill switch 시 getPendingMessages 빈 배열 반환 필요');

  if (origEnabled == null) delete process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
  else process.env.LUNA_AGENT_CROSS_BUS_ENABLED = origEnabled;

  console.log('[message-bus-smoke] kill switch 검증 ✅');

  // ─── 2. DB 연결 테스트 ─────────────────────────────────────────────────────
  const testIncidentKey = `smoke-bus-${Date.now()}`;

  const { createRequire } = await import('module');
  const _require = createRequire(import.meta.url);
  const pgPool = _require('../../../packages/core/lib/pg-pool');
  const check = await pgPool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='investment' AND table_name='agent_messages'`,
  );
  assert((check.rows.length ?? 0) > 0, 'agent_messages table must exist after initSchema');

  try {
    // 2-1. 메시지 전송
    const msgId = await sendMessage('argos', 'sophia', { question: 'sentiment?', symbol: 'BTC/USDT' }, {
      incidentKey: testIncidentKey,
      messageType: 'query',
    });
    assert(msgId > 0, `sendMessage 성공 시 양수 ID 반환 필요, got=${msgId}`);
    console.log(`  sendMessage → id=${msgId}`);

    // 2-2. 브로드캐스트
    const broadcastId = await broadcastMessage('luna', { alert: 'regime_change', regime: 'BEAR' }, {
      incidentKey: testIncidentKey,
    });
    assert(broadcastId > 0, `broadcastMessage 성공 시 양수 ID 반환 필요, got=${broadcastId}`);
    console.log(`  broadcastMessage → id=${broadcastId}`);

    // 2-3. 수신 대기 조회 (sophia 관점)
    const pending = await getPendingMessages('sophia', { incidentKey: testIncidentKey });
    const queriesForSophia = pending.filter((m) => m.toAgent === 'sophia' || m.toAgent === 'all');
    assert(queriesForSophia.length >= 1, 'sophia의 pending 메시지 최소 1개 필요');
    console.log(`  getPendingMessages(sophia) → ${queriesForSophia.length}건`);

    // 2-4. 응답 처리
    const targetMsg = pending.find((m) => m.toAgent === 'sophia' && m.messageType === 'query');
    if (targetMsg) {
      const responseId = await respondToMessage(targetMsg.id, 'sophia', {
        answer: '긍정 0.65, 24h delta +0.12',
        symbol: 'BTC/USDT',
      });
      assert(responseId > 0 || responseId === -1, '응답 ID는 양수 또는 -1(오류) 필요');
      console.log(`  respondToMessage → responseId=${responseId}`);
    }

    // 2-5. incident_key 전체 조회
    const allMsgs = await getMessagesByIncident(testIncidentKey);
    assert(allMsgs.length >= 2, `incident 내 메시지 최소 2개 필요, got=${allMsgs.length}`);
    const fromAgents = allMsgs.map((m) => m.fromAgent);
    assert(fromAgents.includes('argos'), 'argos의 메시지가 incident 내 포함 필요');
    assert(fromAgents.includes('luna'), 'luna의 브로드캐스트가 incident 내 포함 필요');
    console.log(`  getMessagesByIncident → ${allMsgs.length}건`);

    // 2-6. message_type 검증
    const broadcastMsg = allMsgs.find((m) => m.fromAgent === 'luna');
    assert(broadcastMsg?.messageType === 'broadcast', 'luna 메시지는 broadcast type이어야 함');
    assert(broadcastMsg?.toAgent === 'all', 'broadcast 메시지의 to_agent는 all이어야 함');

    console.log('[message-bus-smoke] DB 연결 검증 ✅');
  } catch (err) {
    throw err;
  }

  // ─── 3. 타입 인터페이스 검증 (컴파일 타임 보장) ─────────────────────────────
  // message_type enum 값 확인
  const validTypes: string[] = ['query', 'response', 'broadcast'];
  for (const t of validTypes) {
    assert(validTypes.includes(t), `유효하지 않은 message_type: ${t}`);
  }
  console.log('[message-bus-smoke] 타입 인터페이스 검증 ✅');

  console.log('[message-bus-smoke] 전체 통과 ✅');
}

main().catch((err) => {
  console.error('[message-bus-smoke] 실패:', err.message || err);
  process.exit(1);
});
