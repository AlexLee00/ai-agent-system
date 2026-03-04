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

const HELP_TEXT = `🤖 제이(Jay) 명령 안내

📊 시스템 조회
  /status   또는 "시스템 상태", "전체 현황"
  /cost     또는 "비용 얼마야", "토큰 사용량"
  /queue    또는 "알람 큐 확인"
  /mutes    또는 "무음 목록"
  /brief    또는 "야간 브리핑"

🔇 무음 제어
  /mute <대상> <시간>   예) /mute luna 1h
    대상: all | luna | ska | claude
    시간: 30m | 1h | 2h | 1d
  /unmute <대상>

📅 스카팀 (스터디카페)
  "오늘 예약 뭐 있어"       → 예약 목록
  "오늘 매출 얼마야"         → 매출·통계
  "알람 있어?"               → 미해결 알람
  "앤디 재시작해"            → 앤디 재시작
  "지미 죽었어"              → 지미 재시작

🌙 루나팀 (자동매매)
  "루나 상태 어때"           → 현황·잔고
  "루나 리포트 줘"           → 투자 리포트
  "매매 멈춰"                → 거래 일시정지
  "거래 재개해"              → 거래 재개

🔧 클로드팀 (유지보수)
  "덱스터 점검해"            → 시스템 점검
  "전체 점검해줘"            → 전체 점검 (audit)
  "덱스터 수정해"            → 자동 수정
  "아처 실행해"              → 기술 트렌드 분석
  "일일 보고해줘"            → 일일 리포트

🤖 클로드 AI 직접 질문
  /claude <질문>  또는  /ask <질문>
  예) /claude 루나팀 전략 리스크 분석해줘
  예) /claude DB 스키마 최적화 방법 알려줘`;

// ─── bot_commands 유틸 ────────────────────────────────────────────────

/**
 * bot_commands에 명령 삽입 후 id 반환
 */
function insertBotCommand(toBot, command, args = {}) {
  const result = getDb().prepare(`
    INSERT INTO bot_commands (to_bot, command, args)
    VALUES (?, ?, ?)
  `).run(toBot, command, JSON.stringify(args));
  return result.lastInsertRowid;
}

/**
 * bot_commands 결과 폴링 (2초 간격)
 * @returns {string|null} result JSON 문자열 or null (타임아웃)
 */
async function waitForCommandResult(id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = getDb().prepare(`
      SELECT status, result FROM bot_commands WHERE id = ?
    `).get(id);
    if (!row) return null;
    if (row.status === 'done' || row.status === 'error') return row.result;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

/**
 * luna_query/luna_action 결과를 텍스트로 포맷
 */
function formatLunaResult(command, rawResult) {
  if (!rawResult) return '⏱ 루나 응답 없음 (30초 타임아웃)';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ 루나 오류: ${r.error || '알 수 없음'}`;

  switch (command) {
    case 'pause_trading':
    case 'resume_trading':
      return `🌙 ${r.message}`;
    case 'force_report':
      return `📊 ${r.message}`;
    case 'get_status': {
      const lines = ['🌙 루나팀 현황'];
      lines.push(`  상태: ${r.paused ? '⏸ 일시정지' : '▶ 실행 중'}`);
      if (r.paused) lines.push(`  정지 사유: ${r.pause_reason || '없음'}`);
      if (r.last_cycle) lines.push(`  마지막 사이클: ${r.last_cycle}`);
      if (r.balance_usdt !== undefined) lines.push(`  USDT 잔고: $${r.balance_usdt}`);
      return lines.join('\n');
    }
    default:
      return JSON.stringify(r, null, 2);
  }
}

/**
 * claude_action 결과를 텍스트로 포맷
 */
function formatClaudeResult(command, rawResult) {
  if (!rawResult) return '⏱ 클로드팀 응답 없음 (5분 타임아웃)';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ 클로드팀 오류: ${r.error || '알 수 없음'}`;
  return `🔧 ${r.message}`;
}

/**
 * ska_query/ska_action 결과를 텍스트로 포맷
 */
function formatSkaResult(command, rawResult) {
  if (!rawResult) return '⏱ 스카 응답 없음 (30초 타임아웃)';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }

  if (!r.ok) return `⚠️ 스카 오류: ${r.error || '알 수 없음'}`;

  switch (command) {
    case 'query_reservations': {
      const list = r.reservations || [];
      if (list.length === 0) return `📅 ${r.date} 예약 없음`;
      return [`📅 ${r.date} 예약 (${r.count}건)`, ...list].join('\n');
    }
    case 'query_today_stats':
      if (r.message) return `📊 ${r.message}`;
      return `📊 ${r.date} 매출\n  총액: ${(r.total_amount || 0).toLocaleString()}원\n  입장: ${r.entries_count || 0}건`;
    case 'query_alerts': {
      if (r.count === 0) return '✅ 미해결 알람 없음';
      const lines = [`⚠️ 미해결 알람 (${r.count}건)`];
      for (const a of (r.alerts || [])) {
        lines.push(`  • [${a.type}] ${a.title}`);
      }
      return lines.join('\n');
    }
    case 'restart_andy':
    case 'restart_jimmy':
      return `✅ ${r.message}`;
    default:
      return JSON.stringify(r, null, 2);
  }
}

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
async function handleIntent(parsed, msg, notify = async () => {}) {
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

    case 'ska_query':
    case 'ska_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      const cmdId = insertBotCommand('ska', command, args);
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatSkaResult(command, raw);
    }

    case 'luna_query':
    case 'luna_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      const cmdId = insertBotCommand('luna', command, args);
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatLunaResult(command, raw);
    }

    case 'claude_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      await notify(`⏳ 클로드팀에 전달 중...`);
      const cmdId = insertBotCommand('claude', command, args);
      const raw   = await waitForCommandResult(cmdId, 300000);
      return formatClaudeResult(command, raw);
    }

    case 'dexter': {
      await notify(`⏳ 덱스터 점검 중... (최대 2분 소요)`);
      const cmdId = insertBotCommand('claude', 'run_check', {});
      const raw   = await waitForCommandResult(cmdId, 300000);
      return formatClaudeResult('run_check', raw);
    }

    case 'archer': {
      await notify(`⏳ 아처 기술 분석 중... (최대 5분 소요)`);
      const cmdId = insertBotCommand('claude', 'run_archer', {});
      const raw   = await waitForCommandResult(cmdId, 300000);
      return formatClaudeResult('run_archer', raw);
    }

    case 'session_close': {
      await notify(`⏳ 세션 마감 시작합니다...\n문서 업데이트·저널·git commit 처리 중`);
      const cmdId = insertBotCommand('claude', 'session_close', {
        text: msg.text,
        bot: 'orchestrator',
      });
      const raw = await waitForCommandResult(cmdId, 300000); // 5분
      if (!raw) return '⏱ 세션 마감 타임아웃 (5분). 수동으로 확인하세요.';
      let r;
      try { r = JSON.parse(raw); } catch { return raw; }
      if (!r.ok) return `⚠️ 세션 마감 오류: ${r.error || '알 수 없음'}`;
      return `✅ 세션 마감 완료\n\n${r.message}`;
    }

    case 'claude_ask': {
      const query = args.query;
      if (!query) return '⚠️ 질문 내용이 없습니다.\n예) /claude 루나팀 전략 리스크 분석해줘';
      await notify(`⏳ 클로드가 생각 중...`);
      const cmdId = insertBotCommand('claude', 'ask_claude', { query });
      const raw   = await waitForCommandResult(cmdId, 300000);
      if (!raw) return '⏱ 클로드 응답 없음 (5분 타임아웃)';
      let r;
      try { r = JSON.parse(raw); } catch { return raw; }
      if (!r.ok) return `⚠️ 클로드 오류: ${r.error || '알 수 없음'}`;
      return `🤖 클로드\n\n${r.message}`;
    }

    case 'brief': {
      const items = flushMorningQueue();
      if (items.length === 0) return '🌅 야간 보류 알람 없음';
      return buildMorningBriefing(items) || '브리핑 생성 실패';
    }

    case 'queue':
      return getQueueSummary();

    default: {
      // 처리 불가 명령 → 클로드에게 분석 요청 (NLP 자동 개선)
      await notify(`🤔 잠깐, 클로드에게 확인해볼게요...`);
      const cmdId = insertBotCommand('claude', 'analyze_unknown', { text: msg.text });
      const raw   = await waitForCommandResult(cmdId, 120000); // 2분
      if (!raw) return `❓ 명령을 이해하지 못했습니다.\n/help 로 명령 목록을 확인하세요.`;
      let r;
      try { r = JSON.parse(raw); } catch { return raw; }
      if (!r.ok) return `❓ 명령을 이해하지 못했습니다.\n/help 로 명령 목록을 확인하세요.`;
      return r.message;
    }
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
    const response = await handleIntent(parsed, msg, sendReply);

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
