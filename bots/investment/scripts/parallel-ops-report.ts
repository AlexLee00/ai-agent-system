#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildScreeningHistoryReport } from './screening-history-report.ts';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INVESTMENT_ROOT = path.resolve(__dirname, '..');

function runCommand(command, args) {
  return execFileSync(command, args, {
    cwd: INVESTMENT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function tryRunCommand(command, args) {
  try {
    return { ok: true, output: runCommand(command, args) };
  } catch (error) {
    return {
      ok: false,
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

function parseJsonFromMixedOutput(output) {
  const text = String(output || '').trim();
  if (!text) throw new Error('empty output');

  try {
    return JSON.parse(text);
  } catch {
    // health-report.ts may print setup/status lines before the final JSON block.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('JSON payload not found');
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

function loadHealthReport() {
  const result = tryRunCommand('node', [
    path.resolve(INVESTMENT_ROOT, 'scripts', 'health-report.ts'),
    '--json',
  ]);
  if (!result.ok) {
    return {
      serviceHealth: { okCount: 0, warnCount: 0, ok: [], warn: [] },
      cryptoLiveGateHealth: null,
      error: String(result.error || 'health-report failed').trim(),
    };
  }
  const parsed = parseJsonFromMixedOutput(result.output);
  return { ...parsed, error: null };
}

async function loadScreeningSummary() {
  const markets = ['crypto', 'domestic', 'overseas'];
  const result = {};
  for (const market of markets) {
    try {
      const report = await buildScreeningHistoryReport({ market, limit: 3, json: true });
      result[market] = report.summary;
    } catch (error) {
      result[market] = { error: String(error?.message || error) };
    }
  }
  return result;
}

function summarizeScreening(screening = {}) {
  const lines = [];
  for (const market of ['crypto', 'domestic', 'overseas']) {
    const summary = screening[market];
    if (!summary || summary.error) {
      lines.push(`${market}: unavailable`);
      continue;
    }
    const delta = Number(summary.trend?.deltaDynamicCount || 0);
    const signedDelta = `${delta >= 0 ? '+' : ''}${delta}`;
    const added = (summary.trend?.addedSymbols || []).slice(0, 2).join(', ');
    const removed = (summary.trend?.removedSymbols || []).slice(0, 2).join(', ');
    let line = `${market}: ${summary.trend?.latestDynamicCount ?? 0}개 (${signedDelta})`;
    if (added) line += ` | 추가 ${added}`;
    if (removed) line += ` | 제외 ${removed}`;
    lines.push(line);
  }
  return lines;
}

function buildActionItems(health, decision) {
  if (decision.status === 'baseline_ok') {
    return [
      '24시간 병렬 운영 관찰을 계속 진행합니다.',
      'launchd 제거 전 동일 기준선이 유지되는지 확인합니다.',
    ];
  }

  if (decision.status === 'hold') {
    return [
      '경고 서비스 원인을 우선 복구합니다.',
      'warnCount가 0으로 내려온 뒤 제거 판단을 재개합니다.',
    ];
  }

  const items = ['health-report/DB 접근 경로를 먼저 확인합니다.'];
  if (health.error) items.push('권한/네트워크 제약이 없는 환경에서 다시 실행합니다.');
  return items;
}

function buildDecision(health) {
  if (health.error) {
    return {
      status: 'needs_attention',
      headline: '병렬 운영 상태를 아직 확정하기 어렵습니다.',
      reasons: ['health-report 조회 실패'],
    };
  }

  if (Number(health.serviceHealth.warnCount || 0) > 0) {
    return {
      status: 'hold',
      headline: '병렬 운영은 계속 유지해야 합니다.',
      reasons: health.serviceHealth.warn || ['경고 서비스가 남아 있습니다.'],
    };
  }

  return {
    status: 'baseline_ok',
    headline: '1차 병렬 운영 기준선은 안정적입니다.',
    reasons: [
      `serviceHealth ok ${health.serviceHealth.okCount} / warn ${health.serviceHealth.warnCount}`,
    ],
  };
}

function formatCompactMessage({ decision, health, screening, actionItems }) {
  const lines = [
    `🧭 병렬 운영: ${decision.status}`,
    `📌 ${decision.headline}`,
    `📊 serviceHealth ok ${health.serviceHealth.okCount} / warn ${health.serviceHealth.warnCount}`,
  ];

  const screeningLines = summarizeScreening(screening).slice(0, 3);
  if (screeningLines.length > 0) {
    lines.push(`🔎 ${screeningLines.join(' | ')}`);
  }

  if (actionItems.length > 0) {
    lines.push(`➡️ ${actionItems[0]}`);
  }

  return lines.join('\n');
}

function formatTextReport({ capturedAt, decision, health, screening, actionItems }) {
  const lines = [
    `🧭 병렬 운영 요약 리포트`,
    `기준: ${new Date(capturedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })} KST`,
    '',
    `상태: ${decision.status}`,
    `요약: ${decision.headline}`,
    '',
    '근거:',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
    `서비스 상태: ok ${health.serviceHealth.okCount} / warn ${health.serviceHealth.warnCount}`,
  ];

  if (health.cryptoLiveGateHealth?.warn?.length) {
    lines.push('');
    lines.push('crypto LIVE gate:');
    lines.push(...health.cryptoLiveGateHealth.warn.map((line) => `- ${line}`));
  }

  lines.push('');
  lines.push('screening 동향:');
  lines.push(...summarizeScreening(screening).map((line) => `- ${line}`));
  lines.push('');
  lines.push('권장 조치:');
  lines.push(...actionItems.map((item) => `- ${item}`));

  return lines.join('\n');
}

export async function buildParallelOpsReport({ json = false } = {}) {
  const health = loadHealthReport();
  const screening = await loadScreeningSummary();
  const decision = buildDecision(health);
  const actionItems = buildActionItems(health, decision);
  const payload = {
    capturedAt: new Date().toISOString(),
    decision,
    actionItems,
    health: {
      serviceHealth: health.serviceHealth,
      cryptoLiveGateHealth: health.cryptoLiveGateHealth,
      error: health.error,
    },
    screening,
  };

  if (json) return payload;
  return formatTextReport(payload);
}

async function main() {
  const json = process.argv.includes('--json');
  const publish = process.argv.includes('--publish');
  const report = await buildParallelOpsReport({ json });
  if (publish) {
    const payload = json ? report : await buildParallelOpsReport({ json: true });
    try {
      await publishAlert({
        from_bot: 'luna',
        event_type: 'report',
        alert_level: payload.decision.status === 'baseline_ok' ? 1 : 2,
        message: formatCompactMessage(payload),
        payload,
      });
    } catch (error) {
      console.warn(`  ⚠️ [parallel-ops-report] 발행 실패(무시): ${error?.message || error}`);
    }
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ parallel-ops-report 오류:',
  });
}
