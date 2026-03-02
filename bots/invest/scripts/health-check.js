#!/usr/bin/env node
'use strict';

/**
 * scripts/health-check.js — 투자봇 가동 상태 조회
 *
 * 실행: node scripts/health-check.js [--json] [--watch]
 */

const fs   = require('fs');
const path = require('path');

const STATUS_FILE    = '/tmp/invest-status.json';
const PIPELINE_LOCK  = '/tmp/invest-ops.lock';
const BRIDGE_LOCK    = '/tmp/invest-bridge.lock';
const SNAPSHOT_FILE  = '/tmp/invest-positions-snapshot.json';
const PIPELINE_LOG   = '/tmp/invest-pipeline.log';

// ─── 헬퍼 ──────────────────────────────────────────────────────────

function ago(iso) {
  if (!iso) return 'N/A';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000)     return `${Math.round(ms / 1000)}초 전`;
  if (ms < 3600000)   return `${Math.round(ms / 60000)}분 전`;
  if (ms < 86400000)  return `${Math.round(ms / 3600000)}시간 전`;
  return `${Math.round(ms / 86400000)}일 전`;
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function lastLogLines(file, n = 5) {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return content.trim().split('\n').slice(-n).join('\n');
  } catch { return '(로그 없음)'; }
}

// ─── 상태 수집 ─────────────────────────────────────────────────────

async function collectStatus() {
  const status     = readJson(STATUS_FILE) || {};
  const snapshot   = readJson(SNAPSHOT_FILE);

  // 프로세스 상태
  const pipelineRunning = fs.existsSync(PIPELINE_LOCK)
    && isProcessAlive(fs.readFileSync(PIPELINE_LOCK, 'utf-8').trim());
  const bridgeRunning = fs.existsSync(BRIDGE_LOCK)
    && isProcessAlive(fs.readFileSync(BRIDGE_LOCK, 'utf-8').trim());

  // DB 조회 (선택적)
  let dbPositions = null;
  let todayPnl    = null;
  try {
    const db = require('../lib/db');
    dbPositions = await db.getAllPositions();
    const pnlRow = await db.getTodayPnl();
    todayPnl = pnlRow.pnl;
    db.close();
  } catch {}

  return {
    status,
    pipelineRunning,
    bridgeRunning,
    snapshot,
    dbPositions,
    todayPnl,
  };
}

// ─── 출력 ──────────────────────────────────────────────────────────

function printStatus(data) {
  const { status, pipelineRunning, bridgeRunning, snapshot, dbPositions, todayPnl } = data;
  const now = new Date().toLocaleString('ko-KR');

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          📈 투자봇 가동 상태                  ║');
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  조회 시각: ${now}`);
  console.log('');

  // ── 프로세스 ──
  console.log('[ 프로세스 ]');
  console.log(`  파이프라인: ${pipelineRunning ? '🟢 실행 중' : '⚫ 대기'}`);
  console.log(`  업비트 브릿지: ${bridgeRunning ? '🟢 실행 중' : '⚫ 대기'}`);
  console.log('');

  // ── 실행 이력 ──
  console.log('[ 실행 이력 ]');
  console.log(`  상태:          ${status.status || 'unknown'}`);
  console.log(`  마지막 실행:   ${ago(status.lastRun)}`);
  console.log(`  총 실행 횟수:  ${status.runCount || 0}회`);
  console.log(`  연속 오류:     ${status.consecutiveErrors || 0}회`);
  if (status.durationMs) {
    console.log(`  마지막 소요:   ${(status.durationMs / 1000).toFixed(1)}초`);
  }
  if (status.lastError) {
    console.log(`  마지막 오류:   ${status.lastError.slice(0, 80)}`);
  }
  console.log('');

  // ── 포지션 ──
  const positions = dbPositions || snapshot?.positions || [];
  console.log(`[ 포지션 ] (${positions.length}개)`);
  if (positions.length === 0) {
    console.log('  (오픈 포지션 없음)');
  } else {
    for (const p of positions) {
      const symbol   = p.symbol;
      const amount   = Number(p.amount || p.amount).toFixed(6);
      const avgPrice = Number(p.avg_price || p.avgPrice).toFixed(2);
      const pnl      = p.unrealized_pnl != null ? `PnL ${p.unrealized_pnl >= 0 ? '+' : ''}${Number(p.unrealized_pnl).toFixed(2)}` : '';
      console.log(`  ${symbol}: ${amount} @ $${avgPrice}  ${pnl}`);
    }
  }
  console.log('');

  // ── 수익 ──
  if (todayPnl !== null) {
    const pnlStr = todayPnl >= 0 ? `+$${todayPnl.toFixed(2)}` : `-$${Math.abs(todayPnl).toFixed(2)}`;
    const emoji  = todayPnl >= 0 ? '📈' : '📉';
    console.log(`[ 오늘 수익 ]  ${emoji} ${pnlStr}`);
    console.log('');
  }

  // ── 최근 로그 ──
  console.log('[ 최근 로그 (5줄) ]');
  console.log(lastLogLines(PIPELINE_LOG, 5).split('\n').map(l => `  ${l}`).join('\n'));
  console.log('');
}

// ─── CLI 실행 ──────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const watch    = args.includes('--watch');

  async function run() {
    const data = await collectStatus();
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      printStatus(data);
    }
  }

  await run();

  if (watch) {
    console.log('(30초마다 갱신, 종료: Ctrl+C)\n');
    setInterval(async () => {
      console.clear();
      await run();
    }, 30000);
  } else {
    process.exit(0);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
