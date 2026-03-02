'use strict';

/**
 * lib/reporter.js — 덱스터 리포트 포맷 + 텔레그램 발송
 */

const fs    = require('fs');
const https = require('https');
const cfg   = require('./config');

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
  console.log(`  시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
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
  lines.push(`📅 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
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

function loadTelegramCreds() {
  for (const p of Object.values(cfg.SECRETS)) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.telegram_bot_token && s.telegram_chat_id) {
        return { token: s.telegram_bot_token, chatId: s.telegram_chat_id };
      }
    } catch { /* try next */ }
  }
  return null;
}

function sendTelegram(text) {
  const creds = loadTelegramCreds();
  if (!creds) return Promise.resolve(false);

  const body = Buffer.from(JSON.stringify({
    chat_id:    creds.chatId,
    text,
    parse_mode: 'Markdown',
  }));

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${creds.token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => { res.resume(); res.on('end', () => resolve(true)); });

    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
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

module.exports = { printReport, buildTelegramText, sendTelegram, writeLog, writeFixLog };
