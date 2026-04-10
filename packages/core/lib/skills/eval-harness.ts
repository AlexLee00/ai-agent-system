// @ts-nocheck
'use strict';

const TEAM_METRICS = {
  luna: [
    { name: '수익률', team: '루나', type: 'rate', target: 0.05, direction: 'higher' },
    { name: '승률', team: '루나', type: 'rate', target: 0.6, direction: 'higher' },
    { name: 'MDD', team: '루나', type: 'rate', target: 0.1, direction: 'lower' },
    { name: '신호정확도', team: '루나', type: 'rate', target: 0.7, direction: 'higher' },
  ],
  ska: [
    { name: '예약성공률', team: '스카', type: 'rate', target: 0.95, direction: 'higher' },
    { name: '정합성일치율', team: '스카', type: 'rate', target: 0.99, direction: 'higher' },
    { name: '실패건수', team: '스카', type: 'number', target: 0, direction: 'lower' },
  ],
  blog: [
    { name: '글자수달성률', team: '블로', type: 'rate', target: 0.9, direction: 'higher' },
    { name: '발행성공률', team: '블로', type: 'rate', target: 0.95, direction: 'higher' },
    { name: '품질점수', team: '블로', type: 'number', target: 80, direction: 'higher' },
  ],
  claude: [
    { name: '에러감지율', team: '클로드', type: 'rate', target: 0.95, direction: 'higher' },
    { name: '복구성공률', team: '클로드', type: 'rate', target: 0.9, direction: 'higher' },
    { name: '코드품질', team: '클로드', type: 'number', target: 85, direction: 'higher' },
  ],
  worker: [
    { name: '가동률', team: '워커', type: 'rate', target: 0.99, direction: 'higher' },
    { name: '응답시간', team: '워커', type: 'duration', target: 500, direction: 'lower' },
    { name: '에러율', team: '워커', type: 'rate', target: 0.01, direction: 'lower' },
  ],
};

// KPI 메트릭 정의
function defineMetric(name, opts) {
  const options = opts || {};
  return {
    name: name || '',
    team: options.team || '',
    type: options.type || 'number',
    target: typeof options.target === 'number' ? options.target : 0,
    direction: options.direction || 'higher',
  };
}

// 메트릭 평가
function evaluate(metric, value) {
  if (!metric) {
    console.warn('[skills/eval-harness] 메트릭 누락');
    return null;
  }

  const target = typeof metric.target === 'number' ? metric.target : 0;
  const val = typeof value === 'number' ? value : 0;
  let pass = false;
  let delta = 0;

  if (metric.direction === 'lower') {
    pass = val <= target;
    delta = target - val; // 양수 = 목표보다 좋음 (낮을수록 좋은 경우)
  } else {
    pass = val >= target;
    delta = val - target; // 양수 = 목표 초과 달성
  }

  return {
    metric: metric.name,
    value: val,
    target,
    pass,
    delta: Math.round(delta * 10000) / 10000,
  };
}

// 복수 메트릭 평가
function runEvalSuite(metrics) {
  const metricList = Array.isArray(metrics) ? metrics : [];
  const results = [];

  for (const item of metricList) {
    if (!item || !item.metric) continue;
    const result = evaluate(item.metric, item.value);
    if (result) results.push(result);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) / 100 : 0,
    },
  };
}

module.exports = { defineMetric, evaluate, runEvalSuite, TEAM_METRICS };
