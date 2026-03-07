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
const pgPool   = require('../../../packages/core/lib/pg-pool');

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
  "코스피 장이야?"            → 국내주식 장 시간

💰 잔고·가격 조회
  "업비트 잔고 얼마야"        → 업비트 계좌 잔고
  "바이낸스 잔고 얼마야"      → 바이낸스 계좌 잔고
  "비트코인 얼마야"           → 암호화폐 현재가 (BTC/ETH/SOL/BNB)
  "국내 주식 잔고"            → KIS 국내주식 보유·손익
  "미국 주식 잔고"            → KIS 해외주식 보유·손익

🌙 루나팀 (자동매매)
  "루나 상태 어때"           → 현황·잔고
  "루나 리포트 줘"           → 투자 리포트
  "매매 멈춰"                → 거래 일시정지
  "거래 재개해"              → 거래 재개
  "업비트 USDT 바이낸스로 보내" → KRW→USDT 매수 후 전송

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

    default: {
      // 처리 불가 명령 → 클로드에게 분석 요청 (NLP 자동 개선)
      await notify(`🤔 잠깐, 클로드에게 확인해볼게요...`);
      const cmdId = await insertBotCommand('claude', 'analyze_unknown', { text: msg.text });
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
