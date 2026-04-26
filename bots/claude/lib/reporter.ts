// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * lib/reporter.js — 덱스터 리포트 포맷 + 알람 발송
 */

const fs     = require('fs');
const cfg    = require('./config');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');

const STATUS_ICON = { ok: '✅', warn: '⚠️', error: '❌' };

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '덱스터';

// ─── 콘솔 출력 ─────────────────────────────────────────────────────

function printReport(results, { elapsed, full }) {
  const overall = results.some(r => r.status === 'error') ? 'error'
                : results.some(r => r.status === 'warn')  ? 'warn'
                : 'ok';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  🤖 ${BOT_NAME} (Dexter) — 시스템 유지보수 리포트      ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  시각: ${kst.toKST(new Date())}`);
  console.log(`  소요: ${elapsed}ms  |  모드: ${full ? '전체' : '기본'}`);
  console.log(`  종합: ${STATUS_ICON[overall]} ${overall.toUpperCase()}\n`);

  for (const r of results) {
    console.log(`${STATUS_ICON[r.status]} [ ${r.name} ]`);
    for (const item of r.items) {
      const icon = STATUS_ICON[item.status] || '  ';
      const indent = item.label.startsWith('  ') ? '    ' : '   ';
      console.log(`${indent}${icon}  ${item.label}: ${item.detail}`);
    }
    console.log('');
  }

  // 요약
  const errors = results.flatMap(r => r.items.filter(i => i.status === 'error'));
  const warns  = results.flatMap(r => r.items.filter(i => i.status === 'warn'));

  if (errors.length + warns.length === 0) {
    console.log('  🎉 모든 체크 통과 — 시스템 정상\n');
  } else {
    console.log(`  📋 요약: ❌ ${errors.length}건  ⚠️ ${warns.length}건`);
    for (const e of errors) console.log(`     ❌ ${e.label}: ${e.detail}`);
    for (const w of warns)  console.log(`     ⚠️  ${w.label}: ${w.detail}`);
    console.log('');
  }
}

// ─── 텔레그램 포맷 ──────────────────────────────────────────────────

function buildTelegramText(results, elapsed) {
  const overall = results.some(r => r.status === 'error') ? 'error'
                : results.some(r => r.status === 'warn')  ? 'warn'
                : 'ok';

  const lines = [];
  lines.push(`🤖 *${BOT_NAME} 유지보수 리포트* ${STATUS_ICON[overall]}`);
  lines.push(`📅 ${kst.toKST(new Date())}`);
  lines.push('');

  for (const r of results) {
    if (r.status === 'ok') continue; // 정상 섹션은 생략
    lines.push(`${STATUS_ICON[r.status]} *${r.name}*`);
    for (const item of r.items.filter(i => i.status !== 'ok')) {
      lines.push(`  ${STATUS_ICON[item.status]} ${item.label}: ${item.detail}`);
    }
    lines.push('');
  }

  if (overall === 'ok') {
    lines.push('✅ 모든 체크 통과 — 시스템 정상');
  }

  lines.push(`_소요: ${elapsed}ms_`);
  return lines.join('\n');
}

// ─── 텔레그램 발송 ──────────────────────────────────────────────────

/**
 * 덱스터 리포트 발송 — 🔧 클로드 Forum Topic 경유
 */
function sendTelegram(text) {
  return postAlarm({
    message: text,
    team: 'claude',
    alertLevel: 1,
    fromBot: 'dexter',
  }).then((result) => result.ok);
}

// ─── 로그 파일 기록 ─────────────────────────────────────────────────

function writeLog(results, elapsed) {
  const ts  = new Date().toISOString();
  const overall = results.some(r => r.status === 'error') ? 'ERROR'
                : results.some(r => r.status === 'warn')  ? 'WARN'
                : 'OK';

  const errors = results.flatMap(r => r.items.filter(i => i.status === 'error'));
  const warns  = results.flatMap(r => r.items.filter(i => i.status === 'warn'));

  const line = `[${ts}] ${overall} | ❌${errors.length} ⚠️${warns.length} | ${elapsed}ms\n`;
  try { fs.appendFileSync(cfg.LOGS.dexter, line); } catch { /* ignore */ }
}

// ─── 자동 픽스 이력 기록 ────────────────────────────────────────────

function writeFixLog(fixes) {
  if (!fixes || fixes.length === 0) return;

  const ts = new Date().toISOString();

  // 실제 처리된 픽스만 기록 (버그레포트 등록 항목 포함)
  const entries = fixes.map(f => ({
    ts,
    label:  f.label,
    status: f.status,
    detail: f.detail,
  }));

  // 기존 로그 로드 (최대 500건 유지)
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(cfg.LOGS.fixes, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch { /* 파일 없으면 신규 */ }

  history.push(...entries);
  if (history.length > 500) history = history.slice(-500);

  try {
    fs.writeFileSync(cfg.LOGS.fixes, JSON.stringify(history, null, 2));
  } catch { /* ignore */ }
}

// ─── agent_events 발행 ──────────────────────────────────────────────

/**
 * 덱스터 체크 결과를 agent_events에 발행 (이중 경로 — 기존 텔레그램 경로 유지)
 * dexter → claude-lead 이벤트 채널
 */
async function emitDexterEvent(results, elapsed) {
  const overall = results.some(r => r.status === 'error') ? 'error'
                : results.some(r => r.status === 'warn')  ? 'warn'
                : 'ok';
  const errors = results.flatMap(r => r.items.filter(i => i.status === 'error'));
  const warns  = results.flatMap(r => r.items.filter(i => i.status === 'warn'));

  try {
    const stateBus = require('./state-bus-bridge.js');
    const priority = overall === 'error' ? 'high' : overall === 'warn' ? 'normal' : 'low';
    await stateBus.emitEvent('dexter', 'claude-lead', 'dexter_check_result', {
      overall,
      errorCount:  errors.length,
      warnCount:   warns.length,
      elapsed,
      issues: errors.concat(warns).map(i => ({
        checkName: i.checkName,
        label:     i.label,
        status:    i.status,
        detail:    (i.detail || '').slice(0, 200),
      })),
    }, priority);
  } catch (e) {
    console.warn('[reporter] agent_events 발행 실패 (무시):', e.message);
  }

  // RAG 저장: ERROR/WARN 이슈를 rag_operations에 학습 데이터로 기록
  if (overall !== 'ok') {
    try {
      const rag      = require('../../../packages/core/lib/rag-safe');
      const topItems = errors.concat(warns).slice(0, 5);
      const content  = [
        `덱스터 점검 ${overall.toUpperCase()}: 오류 ${errors.length}건, 경고 ${warns.length}건`,
        `항목: ${topItems.map(i => `[${i.checkName}] ${i.label}`).join(' / ')}`,
      ].join(' | ');
      await rag.store('operations', content, {
        category:    'incident',
        team:        'claude',
        overall,
        error_count: errors.length,
        warn_count:  warns.length,
      }, 'dexter');
    } catch (e) {
      console.warn('[reporter] RAG 저장 실패 (무시):', e.message);
    }
  }
}

// ─── 심각도별 구조화 알림 ────────────────────────────────────────────

function publishDexterNotice({
  eventType = 'alert',
  level = 2,
  title = '',
  summary = '',
  details = [],
  action = '',
  footer = '',
}) {
  const lines = [
    title ? `${level >= 4 ? '🚨' : '⚠️'} ${title}` : '',
    summary,
    ...details,
    action ? `조치: ${action}` : '',
    footer || '',
    `event_type: ${eventType}`,
  ].filter(Boolean);
  return postAlarm({
    message: lines.join('\n'),
    team: 'claude',
    alertLevel: level,
    fromBot: 'dexter',
  }).then((result) => result.ok);
}

/**
 * ⚠️ WARNING 알림 — 🔧 클로드 Topic
 */
function sendWarning({ service, status, action }) {
  return publishDexterNotice({
    eventType: 'alert',
    level: 2,
    title: '시스템 경고',
    summary: `${service} 상태 확인 필요`,
    details: [
      `서비스: ${service}`,
      `상태: ${status}`,
    ],
    action: action || '모니터링 유지 및 자동 복구 대기',
  });
}

/**
 * 🚨 CRITICAL 알림 — 🚨 긴급 Topic + 마스터 DM (sendCritical 경유)
 */
function sendCriticalAlert({ service, status, impact, taskId }) {
  return publishDexterNotice({
    eventType: 'alert',
    level: 4,
    title: '서비스 장애',
    summary: `${service}에 긴급 대응이 필요합니다`,
    details: [
      `서비스: ${service}`,
      `상태: ${status}`,
      ...(impact ? [`영향: ${impact}`] : []),
      ...(taskId ? [`태스크 ID: #${taskId}`] : []),
    ],
    action: taskId
      ? '독터 자동 복구 태스크를 확인하고 후속 조치를 진행'
      : '긴급 점검 및 복구 경로 확인',
  });
}

/**
 * 🚨 Emergency 모드 전환 알림
 */
function sendEmergencyAlert({ reason }) {
  return publishDexterNotice({
    eventType: 'alert',
    level: 4,
    title: 'Emergency 모드 전환',
    summary: '덱스터 직접 복구 모드가 활성화되었습니다',
    details: [
      `원인: ${reason}`,
    ],
    action: '긴급 복구 진행 상황을 확인하고 정상 모드 복귀를 추적',
    footer: '복구가 완료되면 자동으로 Normal 모드로 전환됩니다.',
  });
}

/**
 * ✅ Normal 모드 복귀 알림 — Emergency 해제 후
 */
function sendNormalModeRestore({ durationMin }) {
  return publishDexterNotice({
    eventType: 'report',
    level: 1,
    title: 'Normal 모드 복귀',
    summary: '클로드 팀장 응답이 정상으로 돌아왔습니다',
    details: [
      `Emergency 유지 시간: ${durationMin}분`,
    ],
    action: '관찰 유지',
  });
}

/**
 * ✅ 복구 완료 알림 — 독터 처리 완료 후
 */
function sendRecoveryComplete({ service, method, durationSec, taskId }) {
  return publishDexterNotice({
    eventType: 'report',
    level: 1,
    title: '복구 완료',
    summary: `${service} 복구가 완료되었습니다`,
    details: [
      `서비스: ${service}`,
      `방법: ${method}`,
      ...(durationSec != null ? [`소요: ${durationSec}초`] : []),
      ...(taskId ? [`태스크 ID: #${taskId}`] : []),
    ],
    action: '후속 경고 재발 여부 관찰',
  });
}

module.exports = {
  printReport, buildTelegramText, sendTelegram, writeLog, writeFixLog, emitDexterEvent,
  sendWarning, sendCriticalAlert, sendEmergencyAlert, sendNormalModeRestore, sendRecoveryComplete,
};
