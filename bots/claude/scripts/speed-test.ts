// @ts-nocheck
'use strict';

/**
 * bots/claude/scripts/speed-test.ts — 로컬 LLM 속도 벤치마크
 *
 * 측정 대상:
 *   - qwen2.5-7b (LOCAL_MODEL_FAST): 현재 배포 fast 모델
 *   - deepseek-r1-32b (LOCAL_MODEL_DEEP): 현재 배포 deep 모델
 *   - 임베딩 모델 (qwen3-embed-0.6b): 현재 배포 embedding 모델
 *
 * 프롬프트: 짧은 한국어 추론 질문 (3회 평균)
 * 임계치: fast > 5000ms, deep > 60000ms → 경고 알림
 *
 * 실행: npx tsx bots/claude/scripts/speed-test.ts
 * 자동: PortAgent (ClaudeSupervisor, 24시간 간격)
 */

import { publishToWebhook } from '../../../packages/core/lib/reporting-hub';
const localLLM = require('../../../packages/core/lib/local-llm-client');

const BOT_NAME = 'claude-speed-test';
const TEST_PROMPT = [{ role: 'user', content: '1+1은? 숫자만 답해.' }];
const EMBED_TEXT = '스카팀 스터디카페 매출 이상 감지 테스트';
const RUNS = 3;
const FAST_WARN_MS = 5_000;
const DEEP_WARN_MS = 60_000;
const EMBED_WARN_MS = 3_000;

interface BenchResult {
  model: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  success: boolean;
  error?: string;
}

async function benchModel(model: string, runs: number): Promise<BenchResult> {
  const timings: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < runs; i++) {
    const start = Date.now();
    try {
      const result = await localLLM.callLocalLLM(model, TEST_PROMPT, {
        timeoutMs: model === localLLM.LOCAL_MODEL_DEEP ? 120_000 : 30_000,
        max_tokens: 10,
      });
      if (result) {
        timings.push(Date.now() - start);
      } else {
        lastError = 'empty response';
        break;
      }
    } catch (err: any) {
      lastError = err.message;
      break;
    }
  }

  if (timings.length === 0) {
    return { model, avgMs: 0, minMs: 0, maxMs: 0, success: false, error: lastError };
  }

  return {
    model,
    avgMs: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
    minMs: Math.min(...timings),
    maxMs: Math.max(...timings),
    success: true,
  };
}

async function benchEmbed(): Promise<BenchResult> {
  const model = localLLM.LOCAL_MODEL_EMBED || 'qwen3-embed-0.6b';
  const timings: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < RUNS; i++) {
    const start = Date.now();
    try {
      const resp = await fetch(localLLM.getEmbeddingsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: EMBED_TEXT }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        timings.push(Date.now() - start);
      } else {
        lastError = `HTTP ${resp.status}`;
        break;
      }
    } catch (err: any) {
      lastError = err.message;
      break;
    }
  }

  if (timings.length === 0) {
    return { model, avgMs: 0, minMs: 0, maxMs: 0, success: false, error: lastError };
  }

  return {
    model,
    avgMs: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
    minMs: Math.min(...timings),
    maxMs: Math.max(...timings),
    success: true,
  };
}

function formatResult(r: BenchResult, warnMs: number): string {
  if (!r.success) return `  ❌ ${r.model}: 실패 (${r.error})`;
  const icon = r.avgMs > warnMs ? '⚠️' : '✅';
  return `  ${icon} ${r.model}: avg ${r.avgMs}ms (min ${r.minMs} / max ${r.maxMs})`;
}

async function main() {
  console.log(`[${BOT_NAME}] 시작 — ${new Date().toISOString()}`);

  const available = await localLLM.isLocalLLMAvailable();
  if (!available) {
    console.log(`[${BOT_NAME}] 로컬 LLM 미가용 — 스킵`);
    await publishToWebhook({
      event: {
        from_bot: BOT_NAME,
        team: 'claude',
        event_type: 'speed_test_result',
        alert_level: 2,
        message: '⚠️ 로컬 LLM 응답 없음 — MLX 서버 상태 확인 필요',
      },
    });
    process.exit(0);
  }

  console.log(`[${BOT_NAME}] ${RUNS}회 벤치마크 시작...`);

  const [fastResult, deepResult, embedResult] = await Promise.all([
    benchModel(localLLM.LOCAL_MODEL_FAST, RUNS),
    benchModel(localLLM.LOCAL_MODEL_DEEP, RUNS),
    benchEmbed(),
  ]);

  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const lines = [
    `🚀 로컬 LLM 속도 테스트 (${now}, ${RUNS}회 평균)`,
    '',
    '📊 추론 모델',
    formatResult(fastResult, FAST_WARN_MS),
    formatResult(deepResult, DEEP_WARN_MS),
    '',
    '🔢 임베딩 모델',
    formatResult(embedResult, EMBED_WARN_MS),
  ];

  const hasWarning =
    (fastResult.success && fastResult.avgMs > FAST_WARN_MS) ||
    (deepResult.success && deepResult.avgMs > DEEP_WARN_MS) ||
    (embedResult.success && embedResult.avgMs > EMBED_WARN_MS) ||
    !fastResult.success ||
    !deepResult.success ||
    !embedResult.success;

  if (hasWarning) {
    lines.push('');
    lines.push('⚠️ 임계치 초과 모델 있음 — 메모리/부하 확인 필요');
  } else {
    lines.push('');
    lines.push('✅ 모든 모델 정상 범위');
  }

  const reportText = lines.join('\n');
  console.log(reportText);

  await publishToWebhook({
    event: {
      from_bot: BOT_NAME,
      team: 'claude',
      event_type: 'speed_test_result',
      alert_level: hasWarning ? 2 : 1,
      message: reportText,
    },
  });

  console.log(`[${BOT_NAME}] 완료`);
}

main().catch((err) => {
  console.error(`[${BOT_NAME}] 오류:`, err.message);
  process.exit(1);
});
