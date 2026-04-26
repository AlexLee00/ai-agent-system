// @ts-nocheck
'use strict';

const { buildPayload } = require('./check-jay-gateway-primary');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    keepUnready: argv.includes('--keep-unready'),
  };
}

function buildPlan(options = {}) {
  const state = buildPayload();
  return {
    retiredGateway: true,
    selectorKey: state.selectorKey,
    currentPrimary: state.selectorPrimary,
    currentFallbacks: state.selectorRoutes,
    readyFallbacks: state.readyFallbacks,
    unreadyFallbacks: state.unreadyFallbacks,
    recommendation: {
      action: options.keepUnready ? 'observe_selector_chain' : 'use_selector_override',
      reason: options.keepUnready
        ? '현재 Hub selector chain을 유지하고 provider readiness만 관찰합니다.'
        : 'fallback 정리는 retired gateway 파일이 아니라 Hub selector override에서 처리합니다.',
    },
    recommendedFallbacks: state.readyFallbacks,
  };
}

function printHuman(plan) {
  const lines = [];
  lines.push('🤖 제이 Hub selector fallback 정리 계획');
  lines.push('');
  lines.push(`selector key: ${plan.selectorKey}`);
  lines.push(`현재 primary: ${plan.currentPrimary}`);
  lines.push(`현재 fallback 개수: ${plan.currentFallbacks.length}`);
  lines.push(`ready fallback 개수: ${plan.readyFallbacks.length}`);
  lines.push(`unready fallback 개수: ${plan.unreadyFallbacks.length}`);
  lines.push('');
  lines.push(`권장 판단: ${plan.recommendation.action}`);
  lines.push(`- ${plan.recommendation.reason}`);
  lines.push('');
  lines.push(`현재 fallback: ${plan.currentFallbacks.join(', ') || '없음'}`);
  lines.push(`ready fallback: ${plan.readyFallbacks.join(', ') || '없음'}`);
  lines.push(`unready fallback: ${plan.unreadyFallbacks.join(', ') || '없음'}`);
  lines.push('');
  lines.push('적용 경로: Hub selector registry 또는 runtime_config selectorOverrides');
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);

  if (args.apply) {
    throw new Error('retired gateway fallback 변경은 비활성화되었습니다. Hub selector override를 사용하세요.');
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
    process.stderr.write(`❌ prune-jay-gateway-fallbacks 실패: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildPlan,
  printHuman,
};
