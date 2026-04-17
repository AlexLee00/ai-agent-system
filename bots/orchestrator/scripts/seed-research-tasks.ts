'use strict';

const tasks = require('../../darwin/lib/research-tasks');

const seeded = [
  tasks.createTask({
    id: 'DARWIN-BACKTEST-001',
    title: 'Freqtrade 소스 코드 분석 -> 자체 백테스트 엔진',
    type: 'github_analysis',
    target: { owner: 'freqtrade', repo: 'freqtrade' },
    description: 'walk-forward, 슬리피지, FreqAI, hyperopt, 지표 파이프라인 핵심 패턴 분석',
    assignee: 'scholar',
    priority: 1,
  }),
  tasks.createTask({
    id: 'DARWIN-ECC-001',
    title: 'ECC 스킬 구조 분석 -> 공용 스킬 확대',
    type: 'github_analysis',
    target: { owner: 'affaan-m', repo: 'everything-claude-code' },
    description: 'search-first, verification-loop, autonomous-loops 패턴 분석',
    assignee: 'scholar',
    priority: 2,
  }),
];

console.log('연구 과제 등록 완료!');
console.log('대기 과제:', seeded.map((task) => task.id).join(', '));
