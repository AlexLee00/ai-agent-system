// k6 Baseline Load Test — 평시 부하 (VU 5, 9분)
// 실행: k6 run --out json=results/baseline.json tests/load/baseline.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const latencyByProvider = new Trend('latency_by_provider', true);
const failRate = new Rate('fail_rate');

const HUB_URL = __ENV.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = __ENV.HUB_AUTH_TOKEN || '';

export const options = {
  stages: [
    { duration: '2m', target: 5 },
    { duration: '5m', target: 5 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    'http_req_duration{status:200}': ['p(95)<5000'],
    latency_by_provider: ['p(99)<15000'],
  },
};

const TEAMS = ['luna', 'blog', 'darwin', 'sigma', 'claude', 'ska'];
const AGENTS = ['default', 'analyst', 'writer', 'research'];

export default function () {
  const team = TEAMS[Math.floor(Math.random() * TEAMS.length)];
  const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];

  const payload = JSON.stringify({
    callerTeam: team,
    agent,
    prompt: '2024 Q4 인공지능 트렌드를 3줄로 요약해줘.',
    abstractModel: 'anthropic_sonnet',
    cacheEnabled: false,
  });

  const res = http.post(`${HUB_URL}/hub/llm/call`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HUB_TOKEN}`,
    },
    timeout: '30s',
  });

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has result': (r) => {
      try { return r.json('ok') === true; } catch { return false; }
    },
  });

  failRate.add(!ok);
  const provider = (res.status === 200 ? (res.json('provider') || 'unknown') : 'error');
  latencyByProvider.add(res.timings.duration, { provider });

  sleep(1 + Math.random() * 3);
}
