// @ts-nocheck
'use strict';

function parseArgs(argv = process.argv.slice(2)) {
  const maxArg = argv.find((arg) => arg.startsWith('--max='));
  const subArg = argv.find((arg) => arg.startsWith('--subagents='));
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    maxConcurrent: Math.max(1, Number(maxArg?.split('=')[1] || 1)),
    subagentMaxConcurrent: Math.max(1, Number(subArg?.split('=')[1] || 2)),
  };
}

function buildPlan(args) {
  return {
    retiredGateway: true,
    current: {
      maxConcurrent: null,
      subagentMaxConcurrent: null,
    },
    recommended: {
      maxConcurrent: args.maxConcurrent,
      subagentMaxConcurrent: args.subagentMaxConcurrent,
    },
    recommendation: {
      action: 'use_hub_selector_limits',
      reason: 'Jay 동시성은 retired gateway 설정 파일이 아니라 Hub selector/provider limiter에서 관리합니다.',
    },
  };
}

function printHuman(plan) {
  const lines = [];
  lines.push('🤖 제이 Hub selector 동시성 점검');
  lines.push('');
  lines.push('retired gateway 설정 변경은 비활성화되었습니다.');
  lines.push(`권장 maxConcurrent: ${plan.recommended.maxConcurrent}`);
  lines.push(`권장 subagents.maxConcurrent: ${plan.recommended.subagentMaxConcurrent}`);
  lines.push('');
  lines.push(`권장 판단: ${plan.recommendation.action}`);
  lines.push(`- ${plan.recommendation.reason}`);
  lines.push('');
  lines.push('적용 경로: Hub provider limiter / selector override / 팀별 cooldown 정책');
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);
  if (args.apply) {
    throw new Error('retired gateway 동시성 변경은 비활성화되었습니다. Hub provider limiter 설정을 사용하세요.');
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(plan)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ tune-jay-gateway-concurrency 실패: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildPlan,
  printHuman,
};
