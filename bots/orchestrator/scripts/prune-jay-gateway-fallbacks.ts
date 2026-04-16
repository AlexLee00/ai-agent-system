// @ts-nocheck
'use strict';

const {
  getOpenClawGatewayModelState,
  updateOpenClawGatewayFallbacks,
} = require('../lib/openclaw-config');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    keepUnready: argv.includes('--keep-unready'),
  };
}

function buildPlan(options = {}) {
  const state = getOpenClawGatewayModelState();
  if (!state.ok) {
    throw new Error(state.error || 'openclaw state unavailable');
  }

  const recommendedFallbacks = options.keepUnready
    ? state.fallbacks.slice()
    : state.readyFallbacks.slice();

  return {
    filePath: state.filePath,
    authPath: state.authPath,
    currentPrimary: state.primary,
    currentFallbacks: state.fallbacks,
    readyFallbacks: state.readyFallbacks,
    unreadyFallbacks: state.unreadyFallbacks,
    recommendation: {
      action: options.keepUnready ? 'observe' : 'prune_unready_fallbacks',
      reason: options.keepUnready
        ? '현재 fallback chain을 유지하고 readiness만 관찰합니다.'
        : '실사용 준비되지 않은 fallback provider를 chain에서 제거해 rate limit 이후 noisy failover를 줄이는 편이 좋습니다.',
    },
    recommendedFallbacks,
  };
}

function printHuman(plan) {
  const lines = [];
  lines.push('🤖 제이 gateway fallback 정리 계획');
  lines.push('');
  lines.push(`설정 파일: ${plan.filePath}`);
  lines.push(`agent auth 파일: ${plan.authPath}`);
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
  lines.push(`권장 fallback 체인: ${plan.recommendedFallbacks.join(', ') || '없음'}`);
  lines.push('');
  lines.push('적용 명령:');
  lines.push(`- 미준비 fallback 제거 적용: node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js --apply`);
  lines.push(`- 현 체인 유지 관찰: node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js --keep-unready`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);

  if (args.apply) {
    const result = updateOpenClawGatewayFallbacks(plan.recommendedFallbacks);
    const output = {
      applied: true,
      filePath: result.filePath,
      fallbackCount: result.fallbackCount,
      fallbacks: result.fallbacks,
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    process.stdout.write(`✅ fallback chain 정리 완료\n- file: ${output.filePath}\n- count: ${output.fallbackCount}\n- fallbacks: ${output.fallbacks.join(', ')}\n`);
    return;
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
