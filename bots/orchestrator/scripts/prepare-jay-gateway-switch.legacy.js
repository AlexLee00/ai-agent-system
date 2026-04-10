#!/usr/bin/env node
'use strict';

const { buildPayload } = require('./check-jay-gateway-primary');

const DEFAULT_CANDIDATE = 'groq_speed';

function parseArgs(argv = process.argv.slice(2)) {
  const candidateArg = argv.find((arg) => arg.startsWith('--candidate='));
  return {
    candidateKey: candidateArg?.split('=').slice(1).join('=') || DEFAULT_CANDIDATE,
    json: argv.includes('--json'),
  };
}

function buildPlan(candidateKey) {
  const payload = buildPayload();
  const candidate = payload.candidateProfiles.find((profile) => profile.key === candidateKey);
  if (!candidate) {
    throw new Error(`unknown candidate: ${candidateKey}`);
  }

  const recommended = payload.aligned && candidate.configured && candidate.authReady;
  const currentPrimary = payload.runtimePrimary;
  const preflightChecks = [
    {
      step: '정합성 확인',
      command: 'node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js --json',
      required: true,
      passCondition: 'runtime_config와 openclaw.json primary가 일치해야 한다.',
    },
    {
      step: '최근 실험 상태 기록',
      command: 'node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-daily.js --hours=24 --days=7 --json',
      required: true,
      passCondition: '최근 권장 판단이 hold 또는 compare 범위로 읽혀야 한다.',
    },
    {
      step: '후보 provider 사용 가능 여부',
      command: 'node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js --json',
      required: true,
      passCondition: `${candidate.model} 후보의 configured=true 그리고 authReady=true 이어야 한다.`,
    },
  ];

  const executionSteps = [
    {
      step: 'runtime_config 변경',
      action: `bots/orchestrator/config.json 의 runtime_config.jayModels.gatewayPrimary 를 ${candidate.model} 로 변경`,
    },
    {
      step: 'OpenClaw 설정 동기화',
      action: 'node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js --apply',
    },
    {
      step: '오케스트레이터 헬스 재확인',
      action: 'node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js --json',
    },
    {
      step: '전환 직후 스냅샷 기록',
      action: 'node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-daily.js --hours=24 --days=7',
    },
    {
      step: '전환 후 비교 리포트',
      action: 'node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-change-compare.js --pivot=<전환시각> --before-hours=24 --after-hours=24',
    },
  ];

  const rollbackCriteria = [
    '전환 후 active rate limit 이 증가하면 즉시 rollback 검토',
    '오케스트레이터 health-report 가 hold 를 벗어나면 rollback 우선',
    'compare 결과가 regressed 이면 Gemini Flash 로 복귀',
  ];

  return {
    currentPrimary,
    candidate: {
      key: candidate.key,
      label: candidate.label,
      model: candidate.model,
      configured: candidate.configured,
      authReady: candidate.authReady,
      pros: candidate.pros,
      cons: candidate.cons,
    },
    recommendation: {
      action: recommended ? 'prepare_compare' : 'blocked',
      reason: recommended
        ? `${candidate.label} 후보는 현재 설정에서 사용 가능하며, 비교 실험 준비가 가능합니다.`
        : `${candidate.label} 후보는 현재 설정, auth readiness, 또는 정합성 조건이 맞지 않아 바로 준비할 수 없습니다.`,
    },
    fallbackReadiness: {
      readyFallbacks: payload.readyFallbacks,
      unreadyFallbacks: payload.unreadyFallbacks,
    },
    preflightChecks,
    executionSteps,
    rollbackCriteria,
  };
}

function printHuman(plan) {
  const lines = [];
  lines.push('🤖 제이 gateway 전환 준비 계획');
  lines.push('');
  lines.push(`현재 primary: ${plan.currentPrimary}`);
  lines.push(`후보: ${plan.candidate.label} (${plan.candidate.model})`);
  lines.push(`configured: ${plan.candidate.configured ? 'yes' : 'no'}`);
  lines.push(`authReady: ${plan.candidate.authReady ? 'yes' : 'no'}`);
  if (plan.fallbackReadiness.unreadyFallbacks.length) {
    lines.push(`unready fallback: ${plan.fallbackReadiness.unreadyFallbacks.join(', ')}`);
  }
  lines.push('');
  lines.push(`권장 판단: ${plan.recommendation.action}`);
  lines.push(`- ${plan.recommendation.reason}`);
  lines.push('');
  lines.push('사전 점검:');
  for (const item of plan.preflightChecks) {
    lines.push(`- ${item.step}`);
    lines.push(`  command: ${item.command}`);
    lines.push(`  pass: ${item.passCondition}`);
  }
  lines.push('');
  lines.push('실행 절차:');
  for (const item of plan.executionSteps) {
    lines.push(`- ${item.step}`);
    lines.push(`  action: ${item.action}`);
  }
  lines.push('');
  lines.push('롤백 기준:');
  for (const item of plan.rollbackCriteria) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

function main() {
  const { candidateKey, json } = parseArgs();
  const plan = buildPlan(candidateKey);
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(plan)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ prepare-jay-gateway-switch 실패: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildPlan,
  printHuman,
};
