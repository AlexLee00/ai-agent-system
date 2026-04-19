#!/usr/bin/env npx ts-node
/**
 * LLM 라우팅 부하 테스트
 *
 * 사용법:
 *   HUB_URL=http://127.0.0.1:7788 \
 *   HUB_AUTH_TOKEN=<token> \
 *   npx ts-node scripts/load-test-llm.ts [concurrency=5] [total=20] [team=luna]
 *
 * 측정 항목:
 *   - 총 요청 수 / 성공률
 *   - 평균/P50/P95/P99/최대 지연 (ms)
 *   - 프로바이더 분포 (claude-code-oauth / groq / failed)
 *   - fallback 발생 횟수
 *   - circuit open 건수
 */

const HUB_URL = process.env.HUB_URL || 'http://127.0.0.1:7788';
const HUB_AUTH_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const CONCURRENCY = Number(process.argv[2] || 5);
const TOTAL = Number(process.argv[3] || 20);
const TEAM = process.argv[4] || 'luna';

if (!HUB_AUTH_TOKEN) {
  console.error('[load-test] HUB_AUTH_TOKEN 환경변수 필수');
  process.exit(1);
}

interface CallResult {
  ok: boolean;
  provider: string;
  durationMs: number;
  fallbackCount: number;
  error?: string;
  wallMs: number;
}

async function singleCall(index: number): Promise<CallResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${HUB_URL}/hub/llm/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUB_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        prompt: `부하 테스트 요청 #${index}: "안녕"을 한국어로 설명해주세요. 한 문장으로만.`,
        abstractModel: 'anthropic_haiku',
        callerTeam: TEAM,
        agent: 'load-test',
        taskType: 'test',
        timeoutMs: 30000,
        cacheEnabled: false,
      }),
      signal: AbortSignal.timeout(35000),
    });

    const wallMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, provider: 'failed', durationMs: wallMs, fallbackCount: 0, error: `HTTP ${res.status}`, wallMs };
    }

    const body = await res.json() as any;
    return {
      ok: body.ok ?? false,
      provider: body.provider ?? 'failed',
      durationMs: body.durationMs ?? wallMs,
      fallbackCount: body.fallbackCount ?? 0,
      error: body.error,
      wallMs,
    };
  } catch (err: any) {
    return { ok: false, provider: 'failed', durationMs: Date.now() - start, fallbackCount: 0, error: err.message, wallMs: Date.now() - start };
  }
}

async function runBatch(indices: number[]): Promise<CallResult[]> {
  return Promise.all(indices.map((i) => singleCall(i)));
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function checkCircuitStatus(): Promise<void> {
  try {
    const res = await fetch(`${HUB_URL}/hub/llm/circuit`, {
      headers: { 'Authorization': `Bearer ${HUB_AUTH_TOKEN}` },
    });
    if (!res.ok) return;
    const body = await res.json() as any;
    if (body.any_open) {
      console.log('\n[circuit] ⚠️  OPEN 서킷 감지:');
      for (const [url, s] of Object.entries(body.local_llm_circuits as Record<string, any>)) {
        if (s.state !== 'CLOSED') {
          console.log(`  ${url}: ${s.state} (failures=${s.failures}, openSince=${Math.round((s.openSinceMs || 0) / 1000)}s)`);
        }
      }
    } else {
      console.log('[circuit] 모든 local 서킷 CLOSED ✅');
    }
  } catch (_) {
    // circuit 엔드포인트 없으면 무시
  }
}

async function main() {
  console.log(`\n🔥 LLM 부하 테스트 시작`);
  console.log(`   Hub: ${HUB_URL}`);
  console.log(`   동시성: ${CONCURRENCY} / 총 요청: ${TOTAL} / 팀: ${TEAM}\n`);

  await checkCircuitStatus();
  console.log('');

  const results: CallResult[] = [];
  const batches: number[][] = [];

  for (let i = 0; i < TOTAL; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, TOTAL - i) }, (_, j) => i + j + 1);
    batches.push(batch);
  }

  const totalStart = Date.now();
  let done = 0;

  for (const batch of batches) {
    const batchResults = await runBatch(batch);
    results.push(...batchResults);
    done += batchResults.length;
    const ok = batchResults.filter((r) => r.ok).length;
    console.log(`  배치 ${done}/${TOTAL}: ${ok}/${batchResults.length} 성공, 평균 ${Math.round(batchResults.reduce((s, r) => s + r.wallMs, 0) / batchResults.length)}ms`);
  }

  const totalMs = Date.now() - totalStart;

  // 집계
  const success = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const providerCounts: Record<string, number> = {};
  let totalFallbacks = 0;

  for (const r of results) {
    providerCounts[r.provider] = (providerCounts[r.provider] || 0) + 1;
    totalFallbacks += r.fallbackCount;
  }

  const wallTimes = results.map((r) => r.wallMs).sort((a, b) => a - b);
  const p50 = percentile(wallTimes, 50);
  const p95 = percentile(wallTimes, 95);
  const p99 = percentile(wallTimes, 99);
  const avg = Math.round(wallTimes.reduce((s, v) => s + v, 0) / wallTimes.length);
  const max = wallTimes[wallTimes.length - 1];

  console.log('\n════════════════════════════════════════');
  console.log('📊 결과 요약');
  console.log('════════════════════════════════════════');
  console.log(`  총 요청:    ${TOTAL}`);
  console.log(`  성공:       ${success.length} (${(success.length / TOTAL * 100).toFixed(1)}%)`);
  console.log(`  실패:       ${failed.length}`);
  console.log(`  전체 소요:  ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  처리량:     ${(TOTAL / totalMs * 1000).toFixed(1)} req/s`);
  console.log('');
  console.log('  지연 분포 (ms):');
  console.log(`    평균: ${avg}`);
  console.log(`    P50:  ${p50}`);
  console.log(`    P95:  ${p95}`);
  console.log(`    P99:  ${p99}`);
  console.log(`    최대: ${max}`);
  console.log('');
  console.log('  프로바이더 분포:');
  for (const [prov, cnt] of Object.entries(providerCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${prov}: ${cnt} (${(cnt / TOTAL * 100).toFixed(1)}%)`);
  }
  console.log(`\n  총 fallback 발생: ${totalFallbacks}`);

  if (failed.length > 0) {
    console.log('\n  실패 샘플:');
    for (const r of failed.slice(0, 3)) {
      console.log(`    ${r.provider}: ${r.error}`);
    }
  }

  console.log('');
  await checkCircuitStatus();
  console.log('');
}

main().catch((err) => {
  console.error('[load-test] 오류:', err.message);
  process.exit(1);
});
