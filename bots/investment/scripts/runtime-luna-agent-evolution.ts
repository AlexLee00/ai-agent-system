#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/runtime-luna-agent-evolution.ts
 * 매주 일요일 06:00 KST — 루나 에이전트 자율 진화 실행
 * launchd: ai.luna.agent-evolution-weekly-sun-0600
 */

import { runLunaAgentEvolution } from '../shared/luna-agent-evolution.ts';
import { isDirectExecution } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const argValue = (name: string, fallback: string) => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    market: argValue('market', 'all'),
    lookbackDays: Math.max(1, Number(argValue('lookback-days', '14')) || 14),
    llmDisabled: argv.includes('--no-llm'),
  };
}

async function main() {
  const args = parseArgs();
  console.log('[runtime-luna-agent-evolution] 시작', args);

  const result = await runLunaAgentEvolution({
    dryRun: args.dryRun,
    market: args.market,
    lookbackDays: args.lookbackDays,
    llmEnabled: !args.llmDisabled,
  });

  if (args.dryRun) {
    console.log('[runtime-luna-agent-evolution] DryRun 결과:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[runtime-luna-agent-evolution] 완료 week=${result.week}`,
      `loss=${result.lossPatterns} win=${result.winPatterns}`,
      `adjustments=${result.priorityAdjustments.length}`,
    );
    console.log('[runtime-luna-agent-evolution] 요약:', result.evolutionSummary);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((err) => {
    console.error('[runtime-luna-agent-evolution] 실패:', err?.message || err);
    process.exit(1);
  });
}

export default main;
