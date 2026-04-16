// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  updateOpenClawGatewayConcurrency,
} = require('../lib/openclaw-config');

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

function readCurrent() {
  const filePath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    filePath,
    currentMaxConcurrent: Number(cfg?.agents?.defaults?.maxConcurrent || 0),
    currentSubagentMaxConcurrent: Number(cfg?.agents?.defaults?.subagents?.maxConcurrent || 0),
  };
}

function buildPlan(args) {
  const current = readCurrent();
  return {
    filePath: current.filePath,
    current: {
      maxConcurrent: current.currentMaxConcurrent,
      subagentMaxConcurrent: current.currentSubagentMaxConcurrent,
    },
    recommended: {
      maxConcurrent: args.maxConcurrent,
      subagentMaxConcurrent: args.subagentMaxConcurrent,
    },
    recommendation: {
      action: 'tune_concurrency',
      reason: '동일 runId 재시도 burst가 관찰되어 gateway 동시성을 한 단계 더 보수적으로 줄여 rate-limit 버스트를 완화하는 편이 좋습니다.',
    },
  };
}

function printHuman(plan) {
  const lines = [];
  lines.push('🤖 제이 gateway 동시성 튜닝 계획');
  lines.push('');
  lines.push(`설정 파일: ${plan.filePath}`);
  lines.push(`현재 maxConcurrent: ${plan.current.maxConcurrent}`);
  lines.push(`현재 subagents.maxConcurrent: ${plan.current.subagentMaxConcurrent}`);
  lines.push(`권장 maxConcurrent: ${plan.recommended.maxConcurrent}`);
  lines.push(`권장 subagents.maxConcurrent: ${plan.recommended.subagentMaxConcurrent}`);
  lines.push('');
  lines.push(`권장 판단: ${plan.recommendation.action}`);
  lines.push(`- ${plan.recommendation.reason}`);
  lines.push('');
  lines.push('적용 명령:');
  lines.push(`- node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/tune-jay-gateway-concurrency.js --apply --max=${plan.recommended.maxConcurrent} --subagents=${plan.recommended.subagentMaxConcurrent}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);
  if (args.apply) {
    const result = updateOpenClawGatewayConcurrency({
      maxConcurrent: args.maxConcurrent,
      subagentMaxConcurrent: args.subagentMaxConcurrent,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`✅ gateway 동시성 튜닝 완료\n- file: ${result.filePath}\n- maxConcurrent: ${result.maxConcurrent}\n- subagents.maxConcurrent: ${result.subagentMaxConcurrent}\n`);
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
    process.stderr.write(`❌ tune-jay-gateway-concurrency 실패: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildPlan,
  printHuman,
};
