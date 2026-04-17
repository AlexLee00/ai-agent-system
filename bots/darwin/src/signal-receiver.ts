/**
 * 다윈팀 Sigma Signal Receiver — Phase 5
 *
 * 시그마 V2 Commander가 보내는 advisory 신호를 구독해
 * 다윈팀 자율 루프에 연결한다.
 */

import { JidoSignal } from '../../../packages/core/lib/jido-signal-client';
import { postAlarm } from '../../../packages/core/lib/openclaw-client';

const signalHub = new JidoSignal({
  endpoint: process.env.TJ_SIGNAL_HUB_URL || 'http://localhost:7788/signal',
  token: process.env.HUB_AUTH_TOKEN || '',
  team: 'darwin',
});

// 시그마가 "지식 축적 권고"를 보낼 때 → 스탠딩 오더 승격
signalHub.subscribe('sigma.advisory.darwin.knowledge_capture', async (signal: any) => {
  const { topic, source, priority } = signal.data || {};
  console.log(`[darwin-signal] 지식 축적 권고 수신: ${topic} (priority: ${priority})`);

  await triggerStandingOrderPromotion({ topic, source, priority });
});

// 시그마가 "연구 주제 추천"을 보낼 때 → 연구 큐 등록
signalHub.subscribe('sigma.advisory.darwin.research_topic', async (signal: any) => {
  const { keywords, rationale, urgency } = signal.data || {};
  console.log(`[darwin-signal] 연구 주제 추천 수신: ${keywords?.join(', ')}`);

  await enqueueResearchTopic({ keywords, rationale, urgency });
});

async function triggerStandingOrderPromotion(data: {
  topic?: string;
  source?: string;
  priority?: string;
}) {
  try {
    await postAlarm({
      from_bot: 'darwin',
      team: 'darwin',
      event_type: 'sigma_standing_order_promote',
      alert_level: 2,
      message: `[다윈] 시그마 권고 → 스탠딩 오더 승격: ${data.topic || '(미명시)'}`,
      payload: data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[darwin-signal] 스탠딩 오더 승격 실패: ${msg}`);
  }
}

async function enqueueResearchTopic(data: {
  keywords?: string[];
  rationale?: string;
  urgency?: string;
}) {
  try {
    await postAlarm({
      from_bot: 'darwin',
      team: 'darwin',
      event_type: 'sigma_research_enqueue',
      alert_level: 1,
      message: `[다윈] 시그마 권고 → 연구 큐 등록: ${(data.keywords || []).join(', ')}`,
      payload: data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[darwin-signal] 연구 큐 등록 실패: ${msg}`);
  }
}

// 직접 실행 시 구독 시작
if (require.main === module) {
  signalHub
    .connect()
    .then(() => {
      console.log('[darwin-signal] Sigma 신호 구독 시작');
    })
    .catch((err: Error) => {
      console.error(`[darwin-signal] 연결 실패: ${err.message}`);
      process.exit(1);
    });
}

export { signalHub };
