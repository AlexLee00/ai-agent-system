'use strict';

// k6 결과 JSON 분석 + DB 저장 + Telegram 리포트
// 실행: npx ts-node tests/load/analyze-results.ts results/

const fs = require('fs');
const path = require('path');

const pgPool = require('../../packages/core/lib/pg-pool');
const sender = require('../../packages/core/lib/telegram-sender');

const SCENARIOS = ['baseline', 'peak', 'chaos', 'multi-team'];

async function analyzeLoadTest(resultsDir) {
  const summary = {};
  const missing = [];

  for (const scenario of SCENARIOS) {
    const filePath = path.join(resultsDir, `${scenario}.json`);
    if (!fs.existsSync(filePath)) {
      missing.push(scenario);
      continue;
    }

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    const metrics = {};
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'Point' && entry.metric) {
          if (!metrics[entry.metric]) metrics[entry.metric] = [];
          metrics[entry.metric].push(entry.data.value);
        }
      } catch {}
    }

    const durations = metrics['http_req_duration'] || [];
    const failed = metrics['http_req_failed'] || [];

    const sorted = [...durations].sort((a, b) => a - b);
    const p = (pct) => sorted[Math.floor(sorted.length * pct / 100)] || 0;

    const failRate = failed.length > 0 ? (failed.filter(v => v > 0).length / failed.length) : 0;

    summary[scenario] = {
      total_requests: durations.length,
      failed_requests: failed.filter(v => v > 0).length,
      fail_rate: failRate,
      p50_latency_ms: Math.round(p(50)),
      p95_latency_ms: Math.round(p(95)),
      p99_latency_ms: Math.round(p(99)),
      avg_latency_ms: Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1)),
    };

    try {
      await pgPool.run(
        'public',
        `INSERT INTO hub.load_test_results
         (scenario, total_requests, failed_requests, fail_rate, p95_latency_ms, p99_latency_ms, avg_latency_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          scenario,
          summary[scenario].total_requests,
          summary[scenario].failed_requests,
          summary[scenario].fail_rate,
          summary[scenario].p95_latency_ms,
          summary[scenario].p99_latency_ms,
          summary[scenario].avg_latency_ms,
        ]
      );
    } catch (e) {
      console.warn(`[load-analyze] DB 저장 실패 (${scenario}):`, e.message);
    }
  }

  const lines = ['📊 LLM Hub 부하 테스트 결과\n'];
  for (const [scenario, s] of Object.entries(summary)) {
    const pass = s.fail_rate < 0.15;
    lines.push(`[${scenario}] ${pass ? '✅' : '❌'}`);
    lines.push(`  요청: ${s.total_requests}건 / 실패율: ${(s.fail_rate * 100).toFixed(1)}%`);
    lines.push(`  P50: ${s.p50_latency_ms}ms / P95: ${s.p95_latency_ms}ms / P99: ${s.p99_latency_ms}ms`);
  }
  if (missing.length) lines.push(`\n⚠️ 결과 파일 없음: ${missing.join(', ')}`);

  const msg = lines.join('\n');
  console.log(msg);
  try {
    await sender.send('general', msg);
  } catch (e) {
    console.warn('[load-analyze] Telegram 전송 실패:', e.message);
  }

  return summary;
}

(async () => {
  const dir = process.argv[2] || 'results';
  if (!fs.existsSync(dir)) {
    console.error(`결과 디렉토리 없음: ${dir}`);
    process.exit(1);
  }
  const result = await analyzeLoadTest(dir);
  console.log('\n[요약]', JSON.stringify(result, null, 2));
  process.exit(0);
})();
