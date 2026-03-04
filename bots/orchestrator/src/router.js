'use strict';

/**
 * src/router.js — 명령 라우팅 + 권한 체크
 *
 * 인텐트 → 핸들러 매핑
 */

const { buildStatus }                    = require('./dashboard');
const { parseIntent }                    = require('../lib/intent-parser');
const { setMute, clearMute, listMutes, parseDuration } = require('../lib/mute-manager');
const { flushMorningQueue, buildMorningBriefing }      = require('../lib/night-handler');
const { buildCostReport }                = require('../lib/token-tracker');
const { invalidate }                     = require('../lib/response-cache');

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
let _db = null;
function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// 허가된 chat_id (secrets에서 로드)
let _allowedChatId = null;
function isAuthorized(chatId) {
  if (!_allowedChatId) {
    try {
      const s = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'reservation', 'secrets.json'), 'utf8'
      ));
      _allowedChatId = String(s.telegram_chat_id);
    } catch { _allowedChatId = '***REMOVED***'; }
  }
  return String(chatId) === _allowedChatId;
}

const HELP_TEXT = `🤖 메인봇 명령 목록

📊 조회
  /status     — 전체 시스템 현황
  /cost       — LLM 토큰/비용 현황
  /queue      — 최근 알람 큐
  /mutes      — 활성 무음 목록

🔇 무음 제어
  /mute <대상> <시간>  — 무음 설정
    대상: all | luna | ska | dexter | archer
         | investment | reservation | claude
    시간: 30m | 1h | 2h | 1d
  /unmute <대상>       — 무음 해제

📋 팀 현황
  /luna    — 루나팀 현황
  /ska     — 스카팀 현황
  /dexter  — 덱스터 시스템 점검 요청
  /archer  — 아처 기술 소화 현황

🌅 기타
  /brief  — 야간 보류 알람 브리핑
  /help   — 이 도움말`;

/**
 * 큐 최근 항목 조회
 */
function getQueueSummary() {
  try {
    const rows = getDb().prepare(`
      SELECT from_bot, event_type, alert_level, message, status, created_at
      FROM mainbot_queue
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    if (rows.length === 0) return '📬 큐가 비어있습니다.';

    const ICONS = { 1: '🔵', 2: '🟡', 3: '🟠', 4: '🔴' };
    const lines = ['📬 최근 알람 큐 (10건)'];
    for (const r of rows) {
      const icon    = ICONS[r.alert_level] || '⚪';
      const time    = r.created_at.slice(11, 16);
      const status  = r.status === 'sent' ? '' : ` [${r.status}]`;
      lines.push(`${icon} ${time} [${r.from_bot}]${status} ${r.message.split('\n')[0].slice(0, 50)}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `큐 조회 실패: ${e.message}`;
  }
}

/**
 * 루나팀 현황 텍스트
 */
function getLunaStatus() {
  try {
    const investState = path.join(os.homedir(), '.openclaw', 'investment-state.json');
    if (!fs.existsSync(investState)) return '📊 루나팀 상태 파일 없음';
    const s = JSON.parse(fs.readFileSync(investState, 'utf8'));
    const lines = ['📊 루나팀 현황'];
    if (s.balance_usdt !== undefined) lines.push(`  USDT 잔고: $${s.balance_usdt?.toFixed(2) || 'N/A'}`);
    if (s.mode)       lines.push(`  모드: ${s.mode}`);
    if (s.updated_at) lines.push(`  갱신: ${s.updated_at?.slice(0, 16)}`);
    return lines.join('\n');
  } catch { return '📊 루나팀 상태 조회 실패'; }
}

/**
 * 스카팀 현황 텍스트
 */
function getSkaStatus() {
  try {
    const stateFile = path.join(os.homedir(), '.openclaw', 'workspace', 'health-check-state.json');
    if (!fs.existsSync(stateFile)) return '📊 스카팀 상태 파일 없음';
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const lines = ['📊 스카팀 현황'];
    if (s.naver_ok !== undefined) lines.push(`  네이버: ${s.naver_ok ? '✅' : '❌'}`);
    if (s.pickko_ok !== undefined) lines.push(`  픽코: ${s.pickko_ok ? '✅' : '❌'}`);
    if (s.checked_at) lines.push(`  갱신: ${s.checked_at?.slice(0, 16)}`);
    return lines.join('\n');
  } catch { return '📊 스카팀 상태 조회 실패'; }
}

/**
 * 인텐트 → 응답 텍스트 처리
 * @param {object} parsed   { intent, args, source }
 * @param {object} msg      Telegram 메시지 객체
 * @returns {Promise<string>}
 */
async function handleIntent(parsed, msg) {
  const { intent, args } = parsed;

  // command_history 기록
  try {
    getDb().prepare(`
      INSERT INTO command_history (raw_text, intent, parse_source, llm_tokens_in, llm_tokens_out, success)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      msg.text || '',
      intent,
      parsed.source || 'unknown',
      parsed.tokensIn  || 0,
      parsed.tokensOut || 0,
    );
  } catch {}

  switch (intent) {
    case 'status':
      invalidate('status'); // 새로 생성
      return await buildStatus();

    case 'cost':
      return buildCostReport();

    case 'help':
      return HELP_TEXT;

    case 'mute': {
      const target   = args.target || 'all';
      const durStr   = args.duration || '1h';
      const dur      = parseDuration(durStr);
      if (!dur) return `⚠️ 시간 형식 오류: ${durStr}\n예) /mute luna 1h`;
      const until    = setMute(target, dur.ms, '사용자 요청');
      return `🔇 [${target}] ${dur.label} 무음 설정\n해제: ${until.slice(0, 16)} KST`;
    }

    case 'unmute': {
      const target = args.target || 'all';
      clearMute(target);
      return `🔔 [${target}] 무음 해제됨`;
    }

    case 'mutes': {
      const mutes = listMutes();
      if (mutes.length === 0) return '🔔 활성 무음 없음';
      return ['🔇 활성 무음 목록', ...mutes.map(m =>
        `  • ${m.target} → ${m.mute_until.slice(0, 16)} KST${m.reason ? ` (${m.reason})` : ''}`
      )].join('\n');
    }

    case 'luna':
      return getLunaStatus();

    case 'ska':
      return getSkaStatus();

    case 'dexter':
      return `🔧 덱스터는 launchd 주기(1시간)로 자동 실행됩니다.\n수동 실행: node bots/claude/src/dexter.js --telegram`;

    case 'archer':
      return `🎯 아처는 매주 월요일 09:00 KST 자동 실행됩니다.\n수동 실행: node bots/claude/src/archer.js --telegram`;

    case 'brief': {
      const items = flushMorningQueue();
      if (items.length === 0) return '🌅 야간 보류 알람 없음';
      return buildMorningBriefing(items) || '브리핑 생성 실패';
    }

    case 'queue':
      return getQueueSummary();

    default:
      return `❓ 명령을 이해하지 못했습니다.\n/help 로 명령 목록을 확인하세요.`;
  }
}

/**
 * Telegram 메시지 처리 메인 진입점
 * @param {object}   msg        Telegram message 객체
 * @param {Function} sendReply  (text) => Promise<void>
 */
async function route(msg, sendReply) {
  if (!msg?.text) return;

  // 권한 체크
  if (!isAuthorized(msg.chat?.id)) {
    console.warn(`[router] 미인가 접근: chat_id=${msg.chat?.id}`);
    return;
  }

  const start = Date.now();
  try {
    const parsed   = await parseIntent(msg.text);
    const response = await handleIntent(parsed, msg);

    // command_history 응답 시간 업데이트
    try {
      getDb().prepare(`
        UPDATE command_history SET response_ms = ?
        WHERE id = (SELECT MAX(id) FROM command_history)
      `).run(Date.now() - start);
    } catch {}

    await sendReply(response);
  } catch (e) {
    console.error(`[router] 처리 오류:`, e);
    await sendReply(`⚠️ 처리 중 오류가 발생했습니다: ${e.message}`);
  }
}

module.exports = { route };
