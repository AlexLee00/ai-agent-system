#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/force-exit-runner.js
 *
 * 목적:
 *   - force-exit 후보 리포트를 기준으로 승인형 stale position 정리 레일 제공
 *   - 기본값은 preview-only
 *   - 명시적 --execute + --confirm=force-exit 가 있을 때만 실제 SELL 실행
 *
 * 실행 예시:
 *   node bots/investment/scripts/force-exit-runner.js
 *   node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas
 *   env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --execute --confirm=force-exit
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { loadCandidates, getMarketLabel } from './force-exit-candidate-report.ts';
import { executeSignal as executeCryptoSignal } from '../team/hephaestos.ts';
import { executeSignal as executeDomesticSignal, executeOverseasSignal } from '../team/hanul.ts';
import {
  getKisExecutionModeInfo,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, ...rest] = arg.slice(2).split('=');
    values[rawKey] = rest.length > 0 ? rest.join('=') : true;
  }

  return {
    json: Boolean(values.json),
    execute: Boolean(values.execute),
    symbol: values.symbol ? String(values.symbol).toUpperCase() : null,
    exchange: values.exchange ? String(values.exchange) : null,
    confirm: values.confirm ? String(values.confirm) : null,
    reason: values.reason ? String(values.reason) : 'force_exit',
  };
}

function pickCandidate(candidates, { symbol, exchange }) {
  if (!symbol) return null;
  return candidates.find((candidate) => {
    if (candidate.symbol !== symbol) return false;
    if (exchange && candidate.exchange !== exchange) return false;
    return true;
  }) || null;
}

function formatPreview(candidate) {
  if (!candidate) return '선택된 force-exit 후보가 없습니다.';
  return [
    '🧾 force-exit 승인형 실행 preview',
    '',
    `- 시장: ${getMarketLabel(candidate.exchange)} (${candidate.exchange})`,
    `- 심볼: ${candidate.symbol}`,
    `- 후보 레벨: ${candidate.candidateLevel}`,
    `- 보유시간: ${candidate.ageHours.toFixed(1)}h`,
    `- 평가금액: ${candidate.positionValue.toFixed(2)}`,
    `- 우선순위: ${candidate.priorityScore}`,
    `- trade_mode: ${candidate.tradeMode || 'normal'}`,
  ].join('\n');
}

async function getExecutionPreflight(candidate) {
  if (!candidate) return { ok: false, level: 'blocked', lines: ['- force-exit 후보가 없습니다.'] };

  if (candidate.exchange === 'binance') {
    return {
      ok: true,
      level: 'ready',
      lines: ['- 암호화폐 레일은 별도 브로커 세션 제약 없이 현재 runner 실행 가능'],
    };
  }

  const modeInfo = getKisExecutionModeInfo(candidate.exchange === 'kis' ? '국내주식' : '해외주식');
  const isMock = modeInfo.brokerAccountMode === 'mock';
  const marketStatus = candidate.exchange === 'kis'
    ? await getKisMarketStatus()
    : getKisOverseasMarketStatus();

  const lines = [
    `- accountMode: ${modeInfo.brokerAccountMode}`,
    `- executionMode: ${modeInfo.executionMode}`,
    `- marketStatus: ${marketStatus.reason}`,
  ];

  if (candidate.exchange === 'kis' && isMock) {
    lines.push('- 국내장 mock 계좌는 장중 SELL 검증용으로는 사용 가능하되, 장종료 이후에는 바로 실패합니다.');
  }

  if (candidate.exchange === 'kis_overseas' && isMock) {
    lines.push('- 해외장 mock 계좌는 현재 SELL 미지원으로 확인되어 force-exit를 차단합니다.');
  }

  if (candidate.exchange === 'kis_overseas' && isMock) {
    return {
      ok: false,
      level: 'blocked',
      lines: [
        ...lines,
        '- KIS API 90000000 기준 모의투자 해외 SELL은 현재 제공되지 않습니다.',
      ],
    };
  }

  if (!marketStatus.isOpen) {
    return {
      ok: false,
      level: 'blocked',
      lines: [
        ...lines,
        '- 현재 장외/휴장 상태라 force-exit SELL 실행을 보류해야 합니다.',
      ],
    };
  }

  return {
    ok: true,
    level: (candidate.exchange === 'kis' && isMock) ? 'guarded' : 'ready',
    lines,
  };
}

async function createForceExitSignal(candidate, reason) {
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: 1,
    reasoning: `승인형 force-exit 실행 (${reason})`,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode || 'normal',
  });

  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode || 'normal',
    exit_reason_override: reason,
  };
}

async function executeCandidate(candidate, reason) {
  const signal = await createForceExitSignal(candidate, reason);
  if (candidate.exchange === 'binance') {
    return executeCryptoSignal(signal);
  }
  if (candidate.exchange === 'kis') {
    return executeDomesticSignal(signal);
  }
  if (candidate.exchange === 'kis_overseas') {
    return executeOverseasSignal(signal);
  }
  throw new Error(`지원하지 않는 exchange: ${candidate.exchange}`);
}

async function main() {
  const options = parseArgs();
  const candidates = await loadCandidates();

  if (!options.symbol) {
    const payload = {
      mode: 'preview',
      totalCandidates: candidates.length,
      candidates,
      usage: [
        'node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas',
        'env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --execute --confirm=force-exit',
      ],
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log('🧾 force-exit 승인형 실행 레일');
    console.log('');
    console.log(`- 후보 수: ${payload.totalCandidates}건`);
    console.log('- 실제 실행은 `--symbol`, `--exchange`, `--execute`, `--confirm=force-exit`가 모두 필요합니다.');
    console.log('- 예시:');
    for (const line of payload.usage) console.log(`  - ${line}`);
    return;
  }

  const candidate = pickCandidate(candidates, options);
  if (!candidate) {
    throw new Error(`force-exit 후보를 찾지 못했습니다: symbol=${options.symbol}${options.exchange ? ` exchange=${options.exchange}` : ''}`);
  }

  if (!options.execute) {
    const preflight = await getExecutionPreflight(candidate);
    const payload = {
      mode: 'preview',
      candidate,
      preflight,
      executeCommand: `env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=${candidate.symbol} --exchange=${candidate.exchange} --execute --confirm=force-exit`,
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(formatPreview(candidate));
    console.log('');
    console.log('- 실행 가능성 점검:');
    for (const line of preflight.lines) console.log(`  ${line}`);
    console.log('');
    console.log(`- 실행 명령: ${payload.executeCommand}`);
    return;
  }

  if (options.confirm !== 'force-exit') {
    throw new Error('실행하려면 --confirm=force-exit 가 필요합니다.');
  }

  const preflight = await getExecutionPreflight(candidate);
  if (!preflight.ok) {
    throw new Error(`force-exit preflight blocked: ${preflight.lines.join(' | ')}`);
  }

  const result = await executeCandidate(candidate, options.reason);
  const payload = {
    mode: 'execute',
    candidate,
    preflight,
    result,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('✅ force-exit 승인형 실행 완료');
  console.log('');
  console.log(formatPreview(candidate));
  console.log('');
  console.log(`- 실행 결과: ${JSON.stringify(result)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[force-exit-runner] ${error?.stack || error?.message || String(error)}`);
    process.exit(1);
  });
}
