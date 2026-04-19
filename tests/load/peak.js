// k6 Peak Load Test — 피크 부하 (최대 VU 50, 7분)
// 실행: k6 run --out json=results/peak.json tests/load/peak.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const failRate = new Rate('fail_rate');

const HUB_URL = __ENV.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = __ENV.HUB_AUTH_TOKEN || '';
const SHORT_MODE = __ENV.SHORT_MODE === 'true';

export const options = {
  stages: SHORT_MODE
    ? [
        { duration: '20s', target: 5 },
        { duration: '40s', target: 10 },
        { duration: '20s', target: 0 },
      ]
    : [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 0 },
      ],
  thresholds: {
    http_req_failed: ['rate<0.15'],
    'http_req_duration{status:200}': ['p(95)<10000'],
  },
};

const TEAMS = ['luna', 'blog', 'darwin', 'sigma', 'claude', 'ska', 'worker', 'editor'];

export default function () {
  const team = TEAMS[Math.floor(Math.random() * TEAMS.length)];

  const payload = JSON.stringify({
    callerTeam: team,
    agent: 'default',
    prompt: '짧게 1문장으로 답해줘: 오늘 날씨 어때?',
    abstractModel: 'anthropic_sonnet',
    cacheEnabled: false,
  });

  const res = http.post(`${HUB_URL}/hub/llm/call`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HUB_TOKEN}`,
    },
    timeout: '45s',
  });

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'ok:true': (r) => {
      try { return r.json('ok') === true; } catch { return false; }
    },
  });

  failRate.add(!ok);
  sleep(0.5 + Math.random() * 1.5);
}
