'use strict';

/**
 * src/router.js — 명령 라우팅 + 권한 체크
 *
 * 인텐트 → 핸들러 매핑
 */

const { buildStatus }                    = require('./dashboard');
const { parseIntent }                    = require('../lib/intent-parser');
const { setMute, clearMute, listMutes, parseDuration, setMuteByEvent, clearMuteByEvent } = require('../lib/mute-manager');
const { flushMorningQueue, buildMorningBriefing }      = require('../lib/night-handler');
const { buildCostReport }                = require('../lib/token-tracker');
const { invalidate }                     = require('../lib/response-cache');

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const pgPool        = require('../../../packages/core/lib/pg-pool');
const shadowMode    = require('../../../packages/core/lib/shadow-mode');
const llmGraduation = require('../../../packages/core/lib/llm-graduation');

// 허가된 chat_id (secrets에서 로드) — 개인 채팅 + 그룹 채팅 모두 허용
let _allowedChatIds = null;
function isAuthorized(chatId) {
  if (!_allowedChatIds) {
    try {
      const s = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'reservation', 'secrets.json'), 'utf8'
      ));
      _allowedChatIds = [s.telegram_chat_id, s.telegram_group_id].filter(Boolean).map(String);
    } catch { _allowedChatIds = ['***REMOVED***']; }
  }
  return _allowedChatIds.includes(String(chatId));
}

const HELP_TEXT = `🤖 제이(Jay) 명령 안내 v2.0

📊 시스템 조회
  /status   또는 "시스템 상태", "전체 현황"
  /cost     또는 "비용 얼마야", "토큰 사용량"
  /queue    또는 "알람 큐 확인"
  /mutes    또는 "무음 목록"
  /brief    또는 "야간 브리핑"
  /stability 또는 "시스템 안정성 현황"

🔇 무음 제어
  /mute <대상> <시간>   예) /mute luna 1h
    대상: all | luna | ska | claude
    시간: 30m | 1h | 2h | 1d
  /unmute <대상>
  "이 알람 안 해도 돼"  → 방금 받은 알람 타입 30일 무음
  "이 알람 다시 알려줘" → 무음 해제

📅 스카팀 (스터디카페)
  "오늘 예약 뭐 있어"       → 예약 목록
  "오늘 매출 얼마야"         → 매출·통계
  "알람 있어?"               → 미해결 알람
  "앤디 재시작해"            → 앤디 재시작
  "지미 죽었어"              → 지미 재시작

📈 시장 현황
  "장 열렸어?"               → 국내/해외/암호화폐 현황
  "미국 장 시간"             → 미국주식 장 시간
  "코스피 장이야?"           → 국내주식 장 시간

💰 잔고·가격 조회
  "업비트 잔고 얼마야"       → 업비트 계좌 잔고
  "바이낸스 잔고 얼마야"     → 바이낸스 계좌 잔고
  "비트코인 얼마야"          → 암호화폐 현재가 (BTC/ETH/SOL/BNB)
  "국내 주식 잔고"           → KIS 국내주식 보유·손익
  "미국 주식 잔고"           → KIS 해외주식 보유·손익

🌙 루나팀 (자동매매)
  "루나 상태 어때"           → 현황·잔고
  "루나 리포트 줘"           → 투자 리포트
  "매매 멈춰"                → 거래 일시정지
  "거래 재개해"              → 거래 재개
  "업비트 USDT 바이낸스로 보내" → KRW→USDT 매수 후 전송
  "매매일지"                 → 최근 매매 기록 (/journal)
  "투자 성과"                → 수익률·기간별 성과 (/performance)
  "TP SL 현황"               → 손절·익절 설정 상태

🔧 클로드팀 (유지보수)
  "덱스터 점검해"            → 시스템 점검
  "전체 점검해줘"            → 전체 점검 (audit)
  "덱스터 수정해"            → 자동 수정
  "덱스터 퀵체크"            → 5분 주기 단기 점검
  "아처 실행해"              → 기술 트렌드 분석
  "일일 보고해줘"            → 일일 리포트 (/dexter)
  "점검 이력"                → 에러 기록 조회

📊 시스템 분석 (신규)
  /shadow       또는 "섀도 리포트" → LLM vs 규칙 비교 리포트
  "섀도 불일치"              → 불일치 케이스 목록
  /graduation   또는 "LLM 졸업 현황" → 규칙 자동전환 후보
  "캐시 통계"                → LLM 캐시 적중률
  "LLM 비용 상세"            → 팀별·모델별 비용
  "텔레그램 상태"            → 폴링 연결 상태

🤖 클로드 AI 직접 질문
  /claude <질문>  또는  /ask <질문>
  예) /claude 루나팀 전략 리스크 분석해줘

🧠 자동학습
  /unrec         → 미인식 명령 목록 조회
  /promote <인텐트> <패턴>  → 패턴 학습 등록
  예) /promote ska_query 오늘 방문객 몇 명이야

💬 자유 대화
  그 외 모든 텍스트 → 팀 키워드 감지 후 위임 또는 AI 자유 대화`;

// ─── bot_commands 유틸 ────────────────────────────────────────────────

/**
 * bot_commands에 명령 삽입 후 id 반환
 */
async function insertBotCommand(toBot, command, args = {}) {
  const rows = await pgPool.query('claude', `
    INSERT INTO bot_commands (to_bot, command, args)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [toBot, command, JSON.stringify(args)]);
  return rows[0]?.id;
}

/**
 * bot_commands 결과 폴링 (2초 간격)
 * @returns {string|null} result JSON 문자열 or null (타임아웃)
 */
async function waitForCommandResult(id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await pgPool.get('claude', `
      SELECT status, result FROM bot_commands WHERE id = $1
    `, [id]);
    if (!row) return null;
    if (row.status === 'done' || row.status === 'error') return row.result;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ─── 미인식 명령 추적 ─────────────────────────────────────────────────

let _unrecTableReady = false;

async function _ensureUnrecTable() {
  if (_unrecTableReady) return;
  try {
    await pgPool.run('claude', `
      CREATE TABLE IF NOT EXISTS unrecognized_intents (
        id           SERIAL PRIMARY KEY,
        text         TEXT NOT NULL,
        parse_source TEXT,
        llm_intent   TEXT,
        promoted_to  TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('claude', `
      CREATE INDEX IF NOT EXISTS idx_unrec_created ON unrecognized_intents(created_at DESC)
    `);
    _unrecTableReady = true;
  } catch {}
}

async function logUnrecognizedIntent(text, source, llmIntent) {
  try {
    await _ensureUnrecTable();
    await pgPool.run('claude', `
      INSERT INTO unrecognized_intents (text, parse_source, llm_intent)
      VALUES ($1, $2, $3)
    `, [text.slice(0, 500), source || 'unknown', llmIntent || null]);
  } catch {}
}

async function buildUnrecognizedReport() {
  try {
    await _ensureUnrecTable();
    const rows = await pgPool.query('claude', `
      SELECT text, COUNT(*) as cnt,
             MAX(llm_intent) as llm_intent,
             MAX(promoted_to) as promoted_to,
             MAX(created_at) as last_seen
      FROM unrecognized_intents
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY text
      ORDER BY cnt DESC, last_seen DESC
      LIMIT 20
    `);
    if (rows.length === 0) return '✅ 최근 7일 미인식 명령 없음';
    const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
    const lines = [`❓ 미인식 명령 (최근 7일, ${rows.length}종 ${total}회)`];
    for (const r of rows) {
      const promoted = r.promoted_to ? ` ✅→${r.promoted_to}` : '';
      lines.push(`  [${r.cnt}회] "${r.text.slice(0, 50)}"${promoted}`);
      if (r.llm_intent && !r.promoted_to) lines.push(`         LLM 추정: ${r.llm_intent}`);
    }
    lines.push('\n/promote <인텐트> <패턴> 으로 학습시킬 수 있습니다.');
    return lines.join('\n');
  } catch (e) {
    return `⚠️ 미인식 이력 조회 실패: ${e.message}`;
  }
}

async function promoteToIntent(text, toIntent, pattern) {
  try {
    await _ensureUnrecTable();
    // DB에 promoted_to 기록
    if (text) {
      await pgPool.run('claude', `
        UPDATE unrecognized_intents
        SET promoted_to = $1
        WHERE text = $2 AND promoted_to IS NULL
      `, [toIntent, text]);
    }
    // nlp-learnings.json에 패턴 추가 (intent-parser.js가 5분 내 자동 로드)
    const learnPath = path.join(os.homedir(), '.openclaw', 'workspace', 'nlp-learnings.json');
    let learnings = [];
    try {
      if (fs.existsSync(learnPath)) learnings = JSON.parse(fs.readFileSync(learnPath, 'utf8'));
    } catch {}
    const re = pattern || text;
    if (re && !learnings.some(l => l.re === re)) {
      learnings.push({ re, intent: toIntent, args: {} });
      fs.writeFileSync(learnPath, JSON.stringify(learnings, null, 2));
    }
  } catch {}
}

// ─── 팀 키워드 감지 + 자유 대화 폴백 ─────────────────────────────────

const TEAM_KEYWORDS = {
  luna:   /루나|luna|투자.*(?:관련|문제|질문)|매매.*(?:관련|문의)|코인.*(?:관련|문의)|포지션.*(?:관련|질문)/i,
  claude: /클로드|claude|덱스터.*(?:관련|문의)|시스템.*(?:문제|오류|질문)|개발.*(?:관련|이슈|문의)/i,
  ska:    /스카|ska|예약.*(?:관련|문의|질문)|스터디카페.*(?:관련|문의)|카페.*(?:운영|문의)/i,
};

async function delegateToTeamLead(team, text) {
  switch (team) {
    case 'luna': {
      // 루나 커맨더에 채팅 쿼리 위임
      const cmdId = await insertBotCommand('luna', 'chat_query', { text });
      const raw = await waitForCommandResult(cmdId, 30000);
      if (!raw) return null;
      try { const r = JSON.parse(raw); return r.ok ? r.message : null; } catch { return null; }
    }
    case 'claude': {
      // 클로드 AI에 직접 질문
      const cmdId = await insertBotCommand('claude', 'ask_claude', { query: text });
      const raw = await waitForCommandResult(cmdId, 60000);
      if (!raw) return null;
      try { const r = JSON.parse(raw); return r.ok ? r.message : null; } catch { return null; }
    }
    case 'ska': {
      return `스카팀 관련 질문은 구체적인 명령으로 말씀해 주세요:\n  "오늘 예약 뭐 있어" · "오늘 매출" · "앤디 재시작해"`;
    }
    default:
      return null;
  }
}

async function geminiChatFallback(text) {
  try {
    const { getGeminiKey } = require('../../../packages/core/lib/llm-keys');
    const key = getGeminiKey();
    if (!key) return null;
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: '너는 AI 봇 시스템의 총괄 허브 제이(Jay)야. 마스터(Alex)가 운영하는 스카팀(스터디카페 관리), 루나팀(암호화폐 자동매매), 클로드팀(시스템 유지보수) 에이전트들을 관리해. 친근하고 간결하게 한국어로 답해. 명령 처리 외의 일반 대화에 짧게 응답해.' },
          { role: 'user',   content: text },
        ],
        max_tokens:  300,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

async function handleChatFallback(text) {
  // 1단계: 팀 키워드 감지 → 팀장 위임
  for (const [team, re] of Object.entries(TEAM_KEYWORDS)) {
    if (re.test(text)) {
      const resp = await delegateToTeamLead(team, text);
      if (resp) return `💬 ${resp}`;
    }
  }
  // 2단계: Gemini Flash 자유 대화
  const resp = await geminiChatFallback(text);
  if (resp) return `💬 ${resp}`;
  return `❓ 명령을 이해하지 못했습니다.\n/help 로 명령 목록을 확인하세요.`;
}

/**
 * 업비트 잔고를 텍스트로 포맷
 */
function formatUpbitBalance(rawResult) {
  if (!rawResult) return '⏱ 업비트 잔고 조회 타임아웃';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ 업비트 잔고 오류: ${r.error || '알 수 없음'}`;

  const lines = ['🟡 업비트 잔고'];
  for (const b of (r.balances || [])) {
    if (b.coin === 'KRW') {
      lines.push(`  KRW: ${b.total.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`);
    } else {
      const krw = b.krw_value ? ` (≈${b.krw_value.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원)` : '';
      lines.push(`  ${b.coin}: ${b.total}${krw}`);
    }
  }
  lines.push(`  합계: ${(r.total_krw || 0).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`);
  return lines.join('\n');
}

/**
 * 바이낸스 잔고를 텍스트로 포맷
 */
function formatBinanceBalance(rawResult) {
  if (!rawResult) return '⏱ 바이낸스 잔고 조회 타임아웃';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ 바이낸스 잔고 오류: ${r.error || '알 수 없음'}`;

  const lines = ['🟠 바이낸스 잔고'];
  for (const b of (r.balances || [])) {
    if (b.coin === 'USDT') {
      lines.push(`  USDT: $${b.total.toFixed(2)}`);
    } else {
      const usd = b.usdt_value ? ` (≈$${b.usdt_value.toFixed(2)})` : '';
      lines.push(`  ${b.coin}: ${b.total}${usd}`);
    }
  }
  lines.push(`  합계: ≈$${(r.total_usdt || 0).toFixed(2)}`);
  return lines.join('\n');
}

/**
 * 암호화폐 현재가를 텍스트로 포맷
 */
function formatCryptoPrice(rawResult) {
  if (!rawResult) return '⏱ 가격 조회 타임아웃';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ 가격 조회 오류: ${r.error || '알 수 없음'}`;

  const lines = ['📈 암호화폐 현재가'];
  for (const s of (r.symbols || [])) {
    const sign    = (s.change_pct ?? 0) >= 0 ? '+' : '';
    const change  = s.change_pct != null ? ` (${sign}${s.change_pct.toFixed(2)}%)` : '';
    lines.push(`  ${s.symbol}: $${(s.price_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}${change}`);
  }
  return lines.join('\n');
}

/**
 * KIS 잔고를 텍스트로 포맷
 */
function formatKisBalance(rawResult, type) {
  if (!rawResult) return '⏱ KIS 잔고 조회 타임아웃';
  let r;
  try { r = JSON.parse(rawResult); } catch { return rawResult; }
  if (!r.ok) return `⚠️ KIS 잔고 오류: ${r.error || '알 수 없음'}`;

  const lines = [];
  if (r.domestic) {
    const d = r.domestic;
    const mode = d.paper ? '[모의]' : '[실전]';
    lines.push(`🇰🇷 국내주식 잔고 ${mode}`);
    if (d.holdings?.length > 0) {
      for (const h of d.holdings) {
        const pnl = h.pnl_amt >= 0 ? `+${h.pnl_amt.toLocaleString()}원` : `${h.pnl_amt.toLocaleString()}원`;
        lines.push(`  ${h.name}(${h.symbol}): ${h.qty}주 ${pnl} (${h.pnl_pct.toFixed(1)}%)`);
      }
    } else {
      lines.push('  보유 종목 없음');
    }
    if (d.total_eval_amt) lines.push(`  평가금액: ${d.total_eval_amt.toLocaleString()}원 | 예수금: ${d.dnca_tot_amt.toLocaleString()}원`);
  }
  if (r.overseas) {
    const o = r.overseas;
    const mode = o.paper ? '[모의]' : '[실전]';
    if (lines.length > 0) lines.push('');
    lines.push(`🇺🇸 해외주식 잔고 ${mode}`);
    if (o.holdings?.length > 0) {
      for (const h of o.holdings) {
        const pnl = (h.pnl_usd || 0) >= 0 ? `+$${(h.pnl_usd).toFixed(2)}` : `-$${Math.abs(h.pnl_usd).toFixed(2)}`;
        lines.push(`  ${h.symbol}: ${h.qty}주 ${pnl} (${(h.pnl_pct || 0).toFixed(1)}%)`);
      }
    } else {
      lines.push('  보유 종목 없음');
    }
    if (o.total_eval_usd) lines.push(`  총평가: $${o.total_eval_usd.toFixed(2)}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'KIS 잔고 없음';
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
async function getQueueSummary() {
  try {
    const rows = await pgPool.query('claude', `
      SELECT from_bot, event_type, alert_level, message, status, created_at
      FROM mainbot_queue
      ORDER BY created_at DESC
      LIMIT 10
    `);

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

// ─── 시장 오픈 여부 (ESM 불가 — 인라인 복사) ─────────────────────────

function _isKisMarketOpen() {
  const now        = new Date();
  const kstOffset  = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstDay     = new Date(now.getTime() + kstOffset * 60000).getUTCDay();
  if (kstDay === 0 || kstDay === 6) return false;
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30;
}

function _isKisOverseasMarketOpen() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const utcDay     = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  const month    = now.getUTCMonth() + 1;
  const isDST    = month >= 4 && month <= 10;
  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc = isDST ? 20 * 60       : 21 * 60;
  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

/**
 * 시장 현황 텍스트 생성
 * @param {'domestic'|'overseas'|'crypto'|'all'} market
 */
function getMarketStatus(market = 'all') {
  const now        = new Date();
  const kstOffset  = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstH       = Math.floor(kstMinutes / 60);
  const kstM       = kstMinutes % 60;
  const kstTimeStr = `${String(kstH).padStart(2,'0')}:${String(kstM).padStart(2,'0')} KST`;

  const domesticOpen = _isKisMarketOpen();
  const overseasOpen = _isKisOverseasMarketOpen();
  const month        = now.getUTCMonth() + 1;
  const isDST        = month >= 4 && month <= 10;

  const lines = [`📊 시장 현황 (${kstTimeStr})`];

  if (market === 'domestic' || market === 'all') {
    const icon = domesticOpen ? '🟢' : '🔴';
    lines.push(`${icon} 국내주식 (KOSPI/KOSDAQ): ${domesticOpen ? '장중 ▶' : '장외 ■'}`);
    if (!domesticOpen) lines.push(`   개장 09:00 / 마감 15:30 KST (평일)`);
  }

  if (market === 'overseas' || market === 'all') {
    const icon    = overseasOpen ? '🟢' : '🔴';
    const openKst = isDST ? '22:30' : '23:30';
    const closeKst = isDST ? '05:00+1' : '06:00+1';
    lines.push(`${icon} 미국주식 (NYSE/NASDAQ): ${overseasOpen ? '장중 ▶' : '장외 ■'}`);
    if (!overseasOpen) lines.push(`   개장 ${openKst} / 마감 ${closeKst} KST (평일${isDST ? ', 서머타임' : ''})`);
  }

  if (market === 'crypto' || market === 'all') {
    lines.push(`🟢 암호화폐 (바이낸스/업비트): 24/7 거래 중`);
  }

  return lines.join('\n');
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
    await pgPool.run('claude', `
      INSERT INTO command_history (raw_text, intent, parse_source, llm_tokens_in, llm_tokens_out, success)
      VALUES ($1, $2, $3, $4, $5, 1)
    `, [
      msg.text || '',
      intent,
      parsed.source || 'unknown',
      parsed.tokensIn  || 0,
      parsed.tokensOut || 0,
    ]);
  } catch {}

  switch (intent) {
    case 'status':
      invalidate('status'); // 새로 생성
      return await buildStatus();

    case 'cost':
      return await buildCostReport();

    case 'help':
      return HELP_TEXT;

    case 'mute': {
      const target   = args.target || 'all';
      const durStr   = args.duration || '1h';
      const dur      = parseDuration(durStr);
      if (!dur) return `⚠️ 시간 형식 오류: ${durStr}\n예) /mute luna 1h`;
      const until    = await setMute(target, dur.ms, '사용자 요청');
      return `🔇 [${target}] ${dur.label} 무음 설정\n해제: ${until.slice(0, 16)} KST`;
    }

    case 'unmute': {
      const target = args.target || 'all';
      await clearMute(target);
      return `🔔 [${target}] 무음 해제됨`;
    }

    case 'mutes': {
      const mutes = await listMutes();
      if (mutes.length === 0) return '🔔 활성 무음 없음';
      return ['🔇 활성 무음 목록', ...mutes.map(m =>
        `  • ${m.target} → ${m.mute_until.slice(0, 16)} KST${m.reason ? ` (${m.reason})` : ''}`
      )].join('\n');
    }

    case 'market_status': {
      const market = args?.market || 'all';
      return getMarketStatus(market);
    }

    case 'luna':
      return getLunaStatus();

    case 'ska':
      return getSkaStatus();

    case 'ska_query':
    case 'ska_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      const cmdId = await insertBotCommand('ska', command, args);
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatSkaResult(command, raw);
    }

    case 'upbit_withdraw': {
      await notify(`⏳ 업비트 USDT 출금 중... (~30초, TRC20 수수료 ~1 USDT 차감)`);
      const cmdId = await insertBotCommand('luna', 'upbit_withdraw_only', {});
      const raw   = await waitForCommandResult(cmdId, 60000);
      if (!raw) return '⏱ 업비트 출금 타임아웃. 업비트 앱에서 출금 내역 확인하세요.';
      let r;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return String(raw); }
      if (!r.ok) return `❌ 출금 실패: ${r.error || '알 수 없음'}`;
      return [
        `✅ 업비트 USDT 출금 완료`,
        `  수량: ${(r.usdtAmount || 0).toFixed(4)} USDT`,
        `  네트워크: ${r.network}`,
        `  상태: ${r.status}`,
        `  (바이낸스 도착: 약 5~30분)`,
      ].join('\n');
    }

    case 'upbit_transfer': {
      await notify(`⏳ 업비트 잔고 확인 중... (소요: ~2분)`);
      const cmdId = await insertBotCommand('luna', 'upbit_to_binance', args || {});
      const raw   = await waitForCommandResult(cmdId, 180000); // 3분 타임아웃
      if (!raw) return '⏱ 업비트→바이낸스 전송 타임아웃 (3분). 업비트 앱에서 직접 확인하세요.';
      let r;
      try { r = JSON.parse(raw); } catch { return raw; }
      if (!r.ok) return `⚠️ 전송 실패: ${r.error || '알 수 없음'}`;
      return `✅ ${r.message}`;
    }

    case 'upbit_balance': {
      const cmdId = await insertBotCommand('luna', 'get_upbit_balance', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatUpbitBalance(raw);
    }

    case 'binance_balance': {
      const cmdId = await insertBotCommand('luna', 'get_binance_balance', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatBinanceBalance(raw);
    }

    case 'crypto_price': {
      const cmdId = await insertBotCommand('luna', 'get_crypto_price', args || {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatCryptoPrice(raw);
    }

    case 'kis_domestic_balance': {
      await notify(`⏳ KIS 국내주식 잔고 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_kis_domestic_balance', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatKisBalance(raw, 'domestic');
    }

    case 'kis_overseas_balance': {
      await notify(`⏳ KIS 해외주식 잔고 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_kis_overseas_balance', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatKisBalance(raw, 'overseas');
    }

    case 'luna_query':
    case 'luna_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      const cmdId = await insertBotCommand('luna', command, args);
      const raw   = await waitForCommandResult(cmdId, 30000);
      return formatLunaResult(command, raw);
    }

    case 'claude_action': {
      const command = args.command;
      if (!command) return '⚠️ 명령 파싱 오류';
      await notify(`⏳ 클로드팀에 전달 중...`);
      const cmdId = await insertBotCommand('claude', command, args);
      const raw   = await waitForCommandResult(cmdId, 300000);
      return formatClaudeResult(command, raw);
    }

    case 'session_close': {
      await notify(`⏳ 세션 마감 시작합니다...\n문서 업데이트·저널·git commit 처리 중`);
      const cmdId = await insertBotCommand('claude', 'session_close', {
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
      const cmdId = await insertBotCommand('claude', 'ask_claude', { query });
      const raw   = await waitForCommandResult(cmdId, 300000);
      if (!raw) return '⏱ 클로드 응답 없음 (5분 타임아웃)';
      let r;
      try { r = JSON.parse(raw); } catch { return raw; }
      if (!r.ok) return `⚠️ 클로드 오류: ${r.error || '알 수 없음'}`;
      return `🤖 클로드\n\n${r.message}`;
    }

    case 'mute_last_alert': {
      const last = await pgPool.get('claude', `
        SELECT from_bot, event_type, message
        FROM mainbot_queue
        WHERE status = 'sent' AND event_type IS NOT NULL AND event_type != ''
        ORDER BY id DESC
        LIMIT 1
      `);
      if (!last?.event_type) return '⚠️ 무음 처리할 최근 알람이 없습니다.';
      const dur = parseDuration(args.duration || '30d') || { ms: 30 * 86400_000, label: '30일' };
      await setMuteByEvent(last.from_bot, last.event_type, dur.ms, '사용자 요청');
      const preview = last.message.split('\n')[0].slice(0, 40);
      return `🔇 알람 무음 설정됨\n봇: ${last.from_bot} / 타입: ${last.event_type}\n"${preview}"\n다시 받으려면: "이 알람 다시 알려줘"`;
    }

    case 'unmute_last_alert': {
      const last = await pgPool.get('claude', `
        SELECT from_bot, event_type, message
        FROM mainbot_queue
        WHERE status = 'sent' AND event_type IS NOT NULL AND event_type != ''
        ORDER BY id DESC
        LIMIT 1
      `);
      if (!last?.event_type) return '⚠️ 해제할 알람이 없습니다.';
      await clearMuteByEvent(last.from_bot, last.event_type);
      return `🔔 알람 무음 해제됨\n봇: ${last.from_bot} / 타입: ${last.event_type}`;
    }

    case 'brief': {
      const items = await flushMorningQueue();
      if (items.length === 0) return '🌅 야간 보류 알람 없음';
      return buildMorningBriefing(items) || '브리핑 생성 실패';
    }

    case 'queue':
      return await getQueueSummary();

    // ── 섀도 모드 ──────────────────────────────────────────────────────

    case 'shadow_report': {
      try {
        const teams   = ['ska', 'claude', 'luna'];
        const reports = [];
        for (const t of teams) {
          const r = await shadowMode.buildShadowReport(t, 7);
          if (r) reports.push(r);
        }
        return reports.length > 0 ? reports.join('\n\n') : '✅ 섀도 로그 없음 (최근 7일)';
      } catch (e) { return `⚠️ 섀도 리포트 오류: ${e.message}`; }
    }

    case 'shadow_mismatches': {
      try {
        const team       = args.team || 'luna';
        const mismatches = await shadowMode.getMismatches(team, null, 7);
        if (!mismatches?.length) return `✅ ${team}팀 불일치 없음 (최근 7일)`;
        const lines = [`🔍 ${team}팀 섀도 불일치 (${mismatches.length}건, 최근 7일)`];
        for (const m of mismatches.slice(0, 15)) {
          const ctx  = m.context || m.team || '?';
          const rule = m.rule_decision || m.decision || '?';
          const llm  = m.llm_decision || m.llm_result?.decision || '?';
          lines.push(`  • [${ctx}] 규칙: ${rule} → LLM: ${llm}`);
        }
        return lines.join('\n');
      } catch (e) { return `⚠️ 섀도 불일치 조회 오류: ${e.message}`; }
    }

    // ── LLM 비용·캐시·졸업 ────────────────────────────────────────────

    case 'llm_cost':
      return await buildCostReport();

    case 'cache_stats': {
      try {
        const rows = await pgPool.query('reservation', `
          SELECT team, COUNT(*) as total,
                 SUM(CASE WHEN expires_at > NOW() THEN 1 ELSE 0 END) as active,
                 COALESCE(SUM(hit_count), 0) as hits
          FROM llm_cache
          GROUP BY team
          ORDER BY hits DESC
        `);
        if (rows.length === 0) return '📦 LLM 캐시 비어있음';
        const lines = ['📦 LLM 캐시 현황'];
        for (const r of rows) {
          lines.push(`  ${r.team}: 전체 ${r.total}건 / 유효 ${r.active}건 / 히트 ${r.hits}회`);
        }
        return lines.join('\n');
      } catch (e) { return `⚠️ 캐시 통계 조회 실패: ${e.message}`; }
    }

    case 'llm_graduation': {
      try {
        const teams   = ['ska', 'claude', 'luna'];
        const reports = [];
        for (const t of teams) {
          const r = await llmGraduation.buildGraduationReport(t);
          if (r) reports.push(r);
        }
        return reports.length > 0 ? reports.join('\n\n') : '✅ LLM 졸업 후보 없음';
      } catch (e) { return `⚠️ 졸업 현황 오류: ${e.message}`; }
    }

    // ── 덱스터 상세 ───────────────────────────────────────────────────

    case 'dexter_report': {
      await notify(`⏳ 덱스터 일일 보고 중...`);
      const cmdId = await insertBotCommand('claude', 'daily_report', {});
      const raw   = await waitForCommandResult(cmdId, 300000);
      return formatClaudeResult('daily_report', raw);
    }

    case 'dexter_quickcheck': {
      await notify(`⏳ 덱스터 퀵체크 실행 중...`);
      const cmdId = await insertBotCommand('claude', 'quick_check', {});
      const raw   = await waitForCommandResult(cmdId, 60000);
      return formatClaudeResult('quick_check', raw);
    }

    case 'doctor_history': {
      try {
        const rows = await pgPool.query('claude', `
          SELECT check_name, status, message, created_at
          FROM dexter_error_log
          ORDER BY created_at DESC
          LIMIT 20
        `);
        if (rows.length === 0) return '✅ 점검 에러 이력 없음';
        const lines = [`🔧 덱스터 에러 이력 (최근 ${rows.length}건)`];
        for (const r of rows) {
          const time = String(r.created_at).slice(0, 16);
          lines.push(`  • [${time}] [${r.check_name}] ${(r.message || '').slice(0, 60)}`);
        }
        return lines.join('\n');
      } catch (e) { return `⚠️ 점검 이력 조회 실패: ${e.message}`; }
    }

    // ── 투자 분석 (루나 커맨더 위임) ──────────────────────────────────

    case 'analyst_accuracy': {
      await notify(`⏳ 애널리스트 정확도 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_analyst_accuracy', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ 애널리스트 정확도 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `📊 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    case 'analyst_weight': {
      await notify(`⏳ 애널리스트 가중치 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_analyst_weight', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ 가중치 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `📊 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    case 'trade_journal': {
      await notify(`⏳ 매매일지 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_trade_journal', args || {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ 매매일지 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `📒 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    case 'trade_review': {
      await notify(`⏳ 매매 리뷰 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_trade_review', args || {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ 매매 리뷰 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `📝 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    case 'performance': {
      await notify(`⏳ 투자 성과 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_performance', args || {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ 성과 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `📈 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    case 'tp_sl_status': {
      await notify(`⏳ TP/SL 현황 조회 중...`);
      const cmdId = await insertBotCommand('luna', 'get_tp_sl_status', {});
      const raw   = await waitForCommandResult(cmdId, 30000);
      if (!raw) return '⏱ TP/SL 조회 타임아웃';
      try { const r = JSON.parse(raw); return r.ok ? `🎯 ${r.message}` : `⚠️ ${r.error || '조회 실패'}`; } catch { return String(raw); }
    }

    // ── 시스템 현황 ───────────────────────────────────────────────────

    case 'stability': {
      invalidate('status');
      return await buildStatus();
    }

    case 'telegram_status': {
      return [
        `📡 텔레그램 폴링 상태`,
        `  수신 폴링: ✅ long-poll (timeout=30s)`,
        `  현재 PID: ${process.pid}`,
        `  업타임: ${Math.floor(process.uptime() / 60)}분 ${Math.floor(process.uptime() % 60)}초`,
      ].join('\n');
    }

    // ── 미인식 명령 관리 ──────────────────────────────────────────────

    case 'unrecognized_report':
      return await buildUnrecognizedReport();

    case 'promote_intent': {
      const { intent: toIntent, pattern, text: uText } = args;
      if (!toIntent || (!pattern && !uText)) {
        return '⚠️ 사용법: /promote <인텐트> <패턴>\n예) /promote ska_query 오늘 방문객 몇 명이야';
      }
      await promoteToIntent(uText || pattern, toIntent, pattern || uText);
      return `✅ "${(uText || pattern).slice(0, 40)}" → ${toIntent} 학습 등록 완료\nnlp-learnings.json 업데이트됨 (5분 내 자동 반영)`;
    }

    // ── 자유 대화 ─────────────────────────────────────────────────────

    case 'chat':
      return await handleChatFallback(msg.text || '');

    default: {
      // 인식됐지만 핸들러 없는 인텐트 → 미인식 로깅 후 chat 폴백
      await logUnrecognizedIntent(
        msg.text || '',
        parsed.source || 'unknown',
        intent !== 'chat' ? intent : null,
      );
      return await handleChatFallback(msg.text || '');
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
      await pgPool.run('claude', `
        UPDATE command_history SET response_ms = $1
        WHERE id = (SELECT MAX(id) FROM claude.command_history)
      `, [Date.now() - start]);
    } catch {}

    await sendReply(response);
  } catch (e) {
    console.error(`[router] 처리 오류:`, e);
    await sendReply(`⚠️ 처리 중 오류가 발생했습니다: ${e.message}`);
  }
}

module.exports = { route };
