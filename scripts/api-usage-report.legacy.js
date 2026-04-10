#!/usr/bin/env node
/**
 * scripts/api-usage-report.js — 레거시 OpenClaw API 로그 리포트
 *
 * 범위:
 *   - ~/.openclaw/api-usage.jsonl 기반
 *   - provider/model 단위 일일 사용량
 *   - Jay 전체 세션 사용량이나 DB 통합 로그는 포함하지 않음
 *
 * 참고:
 *   - Jay 전용 세션 리포트: scripts/reviews/jay-llm-usage-report.js
 *   - 전체 봇 통합 리포트: scripts/llm-usage-unified-report.js
 *
 * 기능:
 *   1. 오늘(KST) API 호출 내역 집계
 *   2. 일일 무료 한도 대비 소진율 표시
 *   3. --telegram 플래그: 텔레그램으로 리포트 전송
 *
 * 사용법:
 *   node scripts/api-usage-report.js
 *   node scripts/api-usage-report.js --telegram
 *   node scripts/api-usage-report.js --date=2026-03-02
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const openclawClient = require('../packages/core/lib/openclaw-client');

const LOG_FILE         = path.join(os.homedir(), '.openclaw', 'api-usage.jsonl');
const SPEED_TEST_KEYS  = path.join(os.homedir(), '.openclaw', 'speed-test-keys.json');

// 무료 API 일일 토큰 한도 (TPD = Tokens Per Day)
const DAILY_LIMITS = {
  'groq/llama-3.1-8b-instant':               500_000,
  'groq/llama-3.3-70b-versatile':            100_000,
  'groq/meta-llama/llama-4-scout-17b-16e-instruct': 100_000,
  'cerebras/llama-3.3-70b':                  1_000_000,
  'cerebras/llama3.1-8b':                    1_000_000,
  'sambanova/Meta-Llama-3.3-70B-Instruct':   10_000,   // 보수적 추정
  'anthropic/claude-haiku-4-5-20251001':     null,      // 유료 — 한도 없음 (비용 추적용)
};

const PROVIDER_ICONS = {
  groq:      '⚡',
  cerebras:  '🧠',
  sambanova: '🔥',
  anthropic: '🤖',
  gemini:    '✨',
};

// ─── 유틸 ─────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const doTelegram = args.includes('--telegram');
const dateArg    = args.find(a => a.startsWith('--date='))?.split('=')[1];

function bold(s)  { return `\x1b[1m${s}\x1b[0m`; }
function dim(s)   { return `\x1b[2m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s){ return `\x1b[33m${s}\x1b[0m`; }
function red(s)   { return `\x1b[31m${s}\x1b[0m`; }
function cyan(s)  { return `\x1b[36m${s}\x1b[0m`; }

function log(msg) { process.stdout.write(msg + '\n'); }

// ─── 데이터 집계 ───────────────────────────────────────────────────
function loadReport(targetDate) {
  if (!fs.existsSync(LOG_FILE)) return {};

  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  const byKey = {};

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      const dateKST = new Date(new Date(r.ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (dateKST !== targetDate) continue;

      const key = `${r.provider}/${r.model}`;
      if (!byKey[key]) byKey[key] = {
        provider: r.provider, model: r.model,
        calls: 0, failedCalls: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        latencies: [],
      };

      byKey[key].calls++;
      if (!r.success) byKey[key].failedCalls++;
      byKey[key].promptTokens     += r.prompt_tokens     || 0;
      byKey[key].completionTokens += r.completion_tokens || 0;
      byKey[key].totalTokens      += r.total_tokens      || 0;
      if (r.latency_ms > 0) byKey[key].latencies.push(r.latency_ms);
    } catch { /* 파싱 실패 무시 */ }
  }

  // 평균 지연시간 계산
  for (const k of Object.keys(byKey)) {
    const lats = byKey[k].latencies;
    byKey[k].avgLatencyMs = lats.length > 0
      ? Math.round(lats.reduce((s, v) => s + v, 0) / lats.length)
      : 0;
    delete byKey[k].latencies;
  }

  return byKey;
}

// ─── 사용률 바 ─────────────────────────────────────────────────────
function usageBar(used, limit, width = 20) {
  if (!limit) return dim('[유료]');
  const pct  = Math.min(used / limit, 1);
  const fill = Math.round(pct * width);
  const bar  = '█'.repeat(fill) + '░'.repeat(width - fill);
  const color = pct >= 0.9 ? red : pct >= 0.7 ? yellow : green;
  return `${color(bar)} ${(pct * 100).toFixed(1)}%`;
}

// ─── Telegram 전송 ─────────────────────────────────────────────────
function sendTelegram(text) {
  return openclawClient.postAlarm({
    team: 'claude-lead',
    message: text,
    alertLevel: 1,
    fromBot: 'api-usage-report',
  }).then((result) => Boolean(result?.ok));
}

// ─── 메인 ─────────────────────────────────────────────────────────
async function main() {
  const todayKST  = dateArg || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const report    = loadReport(todayKST);
  const entries   = Object.values(report);
  const totalCalls  = entries.reduce((s, e) => s + e.calls, 0);
  const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);

  log(bold(`\n📊 OpenClaw API 로그 리포트 — ${todayKST} (KST)`));
  log(dim('─'.repeat(70)));

  if (entries.length === 0) {
    log(dim('  기록 없음'));
    log('');
    return;
  }

  // 터미널 출력
  for (const e of entries.sort((a, b) => b.totalTokens - a.totalTokens)) {
    const icon    = PROVIDER_ICONS[e.provider] || '❓';
    const limKey  = `${e.provider}/${e.model}`;
    const limit   = DAILY_LIMITS[limKey] ?? null;
    const bar     = usageBar(e.totalTokens, limit);
    const failed  = e.failedCalls > 0 ? red(` (실패 ${e.failedCalls})`) : '';

    log(`\n  ${icon} ${bold(e.model)}`);
    log(`     호출: ${e.calls}회${failed}  |  평균 지연: ${cyan(e.avgLatencyMs + 'ms')}`);
    log(`     토큰: 입력 ${e.promptTokens.toLocaleString()} + 출력 ${e.completionTokens.toLocaleString()} = ${bold(e.totalTokens.toLocaleString())}`);
    if (limit) log(`     한도: ${bar}  (${e.totalTokens.toLocaleString()} / ${limit.toLocaleString()})`);
  }

  log(dim('\n─'.repeat(70)));
  log(`  합계: ${bold(totalCalls + '회 호출')}  |  ${bold(totalTokens.toLocaleString() + ' 토큰')}`);
  log('');

  // 텔레그램 리포트
  if (doTelegram) {
    const lines = [`📊 <b>LLM API 사용량</b> (${todayKST} KST)\n`];
    for (const e of entries.sort((a, b) => b.totalTokens - a.totalTokens)) {
      const icon   = PROVIDER_ICONS[e.provider] || '❓';
      const limKey = `${e.provider}/${e.model}`;
      const limit  = DAILY_LIMITS[limKey] ?? null;
      const pct    = limit ? ` (${((e.totalTokens / limit) * 100).toFixed(1)}%)` : '';
      const failed = e.failedCalls > 0 ? ` ⚠️실패${e.failedCalls}` : '';
      lines.push(`${icon} <code>${e.model}</code>`);
      lines.push(`   ${e.calls}회${failed} · ${e.totalTokens.toLocaleString()}토큰${pct} · ${e.avgLatencyMs}ms`);
    }
    lines.push(`\n합계: ${totalCalls}회 · ${totalTokens.toLocaleString()}토큰`);

    process.stdout.write('📨 텔레그램 전송...');
    await sendTelegram(lines.join('\n'));
    log(green(' ✅'));
  }
}

main().catch(e => { log(red(`\n❌ 오류: ${e.message}`)); process.exit(1); });
