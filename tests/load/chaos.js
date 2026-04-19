// k6 Chaos Test — local/MLX 중단 상태에서 Circuit Breaker 동작 확인
// 실행 전: local MLX primary/secondary를 중단하거나 포트를 막기
// k6 run --out json=results/chaos.json tests/load/chaos.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Gauge } from 'k6/metrics';

const fallbackUsed = new Counter('fallback_used');
const circuitOpenCount = new Counter('circuit_open_hit');
const exhaustedCount = new Counter('fallback_exhausted');
const failRate = new Rate('fail_rate');

const HUB_URL = __ENV.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = __ENV.HUB_AUTH_TOKEN || '';

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '5m', target: 10 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    fail_rate: ['rate<0.5'],
    fallback_exhausted: ['count<5'],
  },
};

export default function () {
  // 70% 일반 호출, 20% local 강제, 10% luna critical
  const rand = Math.random();
  let payload;

  if (rand < 0.7) {
    payload = JSON.stringify({
      callerTeam: 'blog',
      agent: 'writer',
      prompt: 'Circuit Breaker 테스트: 짧게 답해줘.',
      abstractModel: 'anthropic_sonnet',
      cacheEnabled: false,
    });
  } else if (rand < 0.9) {
    payload = JSON.stringify({
      callerTeam: 'darwin',
      agent: 'research',
      prompt: '로컬 모델 테스트 요청.',
      abstractModel: 'anthropic_sonnet',
      cacheEnabled: false,
    });
  } else {
    payload = JSON.stringify({
      callerTeam: 'luna',
      agent: 'exit_decision',
      prompt: 'ETH/USDT position exit decision: hold or exit?',
      abstractModel: 'anthropic_sonnet',
      cacheEnabled: false,
    });
  }

  const res = http.post(`${HUB_URL}/hub/llm/call`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HUB_TOKEN}`,
    },
    timeout: '30s',
  });

  let resOk = false;
  try {
    const body = res.json();
    resOk = res.status === 200 && body.ok === true;

    if (body.fallbackCount > 0) fallbackUsed.add(1);
    if (body.error && body.error.includes('circuit_open')) circuitOpenCount.add(1);
    if (body.error && body.error.includes('fallback_exhausted')) exhaustedCount.add(1);
  } catch {}

  check(res, {
    'circuit fallback working': () => resOk || res.status === 200,
  });

  failRate.add(!resOk);

  // Circuit Breaker 상태 확인 (20% 확률)
  if (Math.random() < 0.2) {
    const circuitRes = http.get(`${HUB_URL}/hub/llm/circuit`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      timeout: '5s',
    });
    check(circuitRes, { 'circuit endpoint ok': (r) => r.status === 200 });
  }

  sleep(1 + Math.random() * 2);
}
