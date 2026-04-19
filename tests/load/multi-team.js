// k6 Multi-Team Concurrent — 9팀 독립 동시 호출 (실전 시나리오)
// k6 run --out json=results/multi-team.json tests/load/multi-team.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const HUB_URL = __ENV.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = __ENV.HUB_AUTH_TOKEN || '';
const SHORT_MODE = __ENV.SHORT_MODE === 'true';

const lunaFailRate = new Rate('luna_fail_rate');
const blogFailRate = new Rate('blog_fail_rate');
const darwinFailRate = new Rate('darwin_fail_rate');
const overallFailRate = new Rate('overall_fail_rate');

export const options = {
  scenarios: {
    luna_realtime: {
      executor: 'constant-arrival-rate',
      rate: SHORT_MODE ? 2 : 6,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 2,
      exec: 'callLunaExit',
    },
    blog_writer: {
      executor: 'constant-arrival-rate',
      rate: SHORT_MODE ? 1 : 2,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callBlogWriter',
    },
    darwin_research: {
      executor: 'constant-arrival-rate',
      rate: SHORT_MODE ? 1 : 3,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callDarwinResearch',
    },
    sigma_general: {
      executor: 'constant-arrival-rate',
      rate: SHORT_MODE ? 1 : 2,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callSigma',
    },
    claude_monitor: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callClaude',
    },
    ska_skill: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callSka',
    },
    worker_general: {
      executor: 'constant-arrival-rate',
      rate: SHORT_MODE ? 1 : 2,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callWorker',
    },
    editor_general: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1m',
      duration: SHORT_MODE ? '90s' : '10m',
      preAllocatedVUs: 1,
      exec: 'callEditor',
    },
  },
  thresholds: {
    luna_fail_rate: ['rate<0.05'],
    overall_fail_rate: ['rate<0.15'],
    'http_req_duration{scenario:luna_realtime}': ['p(95)<8000'],
    'http_req_duration{scenario:blog_writer}': ['p(95)<30000'],
  },
};

function callHub(team, agent, prompt) {
  return http.post(
    `${HUB_URL}/hub/llm/call`,
    JSON.stringify({ callerTeam: team, agent, prompt, abstractModel: 'anthropic_sonnet', cacheEnabled: false }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUB_TOKEN}` }, timeout: '35s' }
  );
}

export function callLunaExit() {
  const res = callHub('luna', 'exit_decision', 'ETH/USDT: current RSI 72, MACD cross bearish. Exit or hold?');
  const ok = check(res, { 'luna exit ok': (r) => r.status === 200 });
  lunaFailRate.add(!ok);
  overallFailRate.add(!ok);
  sleep(0.5);
}

export function callBlogWriter() {
  const res = callHub('blog', 'writer', '2025년 AI 트렌드 블로그 포스트 도입부 2문단 작성해줘.');
  const ok = check(res, { 'blog writer ok': (r) => r.status === 200 });
  blogFailRate.add(!ok);
  overallFailRate.add(!ok);
  sleep(1);
}

export function callDarwinResearch() {
  const res = callHub('darwin', 'research', 'DeepSeek V3과 Claude 3.7 Sonnet 비교 분석 요약.');
  const ok = check(res, { 'darwin research ok': (r) => r.status === 200 });
  darwinFailRate.add(!ok);
  overallFailRate.add(!ok);
  sleep(1);
}

export function callSigma() {
  const res = callHub('sigma', 'default', '스터디카페 예약 현황 분석 요청.');
  const ok = check(res, { 'sigma ok': (r) => r.status === 200 });
  overallFailRate.add(!ok);
  sleep(1);
}

export function callClaude() {
  const res = callHub('claude', 'default', '시스템 모니터링 상태 점검.');
  const ok = check(res, { 'claude ok': (r) => r.status === 200 });
  overallFailRate.add(!ok);
  sleep(2);
}

export function callSka() {
  const res = callHub('ska', 'default', '오늘 예약 현황을 요약해줘.');
  const ok = check(res, { 'ska ok': (r) => r.status === 200 });
  overallFailRate.add(!ok);
  sleep(2);
}

export function callWorker() {
  const res = callHub('worker', 'default', '비즈니스 태스크 처리 요청.');
  const ok = check(res, { 'worker ok': (r) => r.status === 200 });
  overallFailRate.add(!ok);
  sleep(1);
}

export function callEditor() {
  const res = callHub('editor', 'default', '영상 편집 스크립트 생성.');
  const ok = check(res, { 'editor ok': (r) => r.status === 200 });
  overallFailRate.add(!ok);
  sleep(2);
}
