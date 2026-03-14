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
const { spawn } = require('child_process');
const pgPool        = require('../../../packages/core/lib/pg-pool');
const shadowMode    = require('../../../packages/core/lib/shadow-mode');
const llmGraduation = require('../../../packages/core/lib/llm-graduation');

// 블로그팀 커리큘럼 플래너 (lazy-load: blog 봇이 없는 환경에서도 오케스트레이터 기동 가능)
let _curriculumPlanner = null;
function _getCP() {
  if (!_curriculumPlanner) {
    try { _curriculumPlanner = require('../../blog/lib/curriculum-planner'); } catch { /* 미설치 */ }
  }
  return _curriculumPlanner;
}

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
  /speed    또는 "속도 체크", "모델 속도 테스트"
  /logs     또는 "최근 오류 보여줘", "로그 확인"
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
  /promotions    → 자동 반영 후보 조회
  /rollback <문구> → 자동 반영 패턴 롤백
  /promote <인텐트> <패턴>  → 패턴 학습 등록
  예) /promote ska_query 오늘 방문객 몇 명이야
  반복 표현은 자동 후보로 누적되고, 조건 충족 시 learned pattern에 자동 반영됨

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
const AUTO_PROMOTE_WINDOW_DAYS = 30;
const AUTO_PROMOTE_MIN_COUNT = 5;
const AUTO_PROMOTE_MIN_CONFIDENCE = 0.8;

function normalizeIntentText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAutoLearnPattern(text = '') {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  return normalized.split(' ').map(escapeRegex).join('\\s+');
}

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
    await pgPool.run('claude', `
      CREATE TABLE IF NOT EXISTS intent_promotion_candidates (
        id               SERIAL PRIMARY KEY,
        normalized_text  TEXT NOT NULL UNIQUE,
        sample_text      TEXT NOT NULL,
        suggested_intent TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        confidence       NUMERIC(5,4) NOT NULL DEFAULT 0,
        auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
        learned_pattern  TEXT,
        first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('claude', `
      CREATE INDEX IF NOT EXISTS idx_promotion_candidates_last_seen
      ON intent_promotion_candidates(last_seen_at DESC)
    `);
    await pgPool.run('claude', `
      CREATE TABLE IF NOT EXISTS intent_promotion_events (
        id               SERIAL PRIMARY KEY,
        candidate_id     INTEGER,
        normalized_text  TEXT,
        sample_text      TEXT,
        suggested_intent TEXT,
        event_type       TEXT NOT NULL,
        learned_pattern  TEXT,
        actor            TEXT NOT NULL DEFAULT 'system',
        metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('claude', `
      CREATE INDEX IF NOT EXISTS idx_promotion_events_created
      ON intent_promotion_events(created_at DESC)
    `);
    _unrecTableReady = true;
  } catch {}
}

async function logPromotionEvent({
  candidateId = null,
  normalizedText = null,
  sampleText = null,
  suggestedIntent = null,
  eventType,
  learnedPattern = null,
  actor = 'system',
  metadata = {},
}) {
  if (!eventType) return;
  await pgPool.run('claude', `
    INSERT INTO intent_promotion_events (
      candidate_id, normalized_text, sample_text, suggested_intent,
      event_type, learned_pattern, actor, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    candidateId,
    normalizedText,
    sampleText,
    suggestedIntent,
    eventType,
    learnedPattern,
    actor,
    JSON.stringify(metadata || {}),
  ]);
}

async function upsertPromotionCandidate({ normalizedText, sampleText, suggestedIntent, occurrenceCount, confidence, autoApplied, learnedPattern }) {
  if (!normalizedText || !suggestedIntent) return;
  await pgPool.run('claude', `
    INSERT INTO intent_promotion_candidates (
      normalized_text, sample_text, suggested_intent, occurrence_count,
      confidence, auto_applied, learned_pattern, first_seen_at, last_seen_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
    ON CONFLICT (normalized_text) DO UPDATE
    SET sample_text      = EXCLUDED.sample_text,
        suggested_intent = EXCLUDED.suggested_intent,
        occurrence_count = EXCLUDED.occurrence_count,
        confidence       = EXCLUDED.confidence,
        auto_applied     = intent_promotion_candidates.auto_applied OR EXCLUDED.auto_applied,
        learned_pattern  = COALESCE(intent_promotion_candidates.learned_pattern, EXCLUDED.learned_pattern),
        last_seen_at     = NOW(),
        updated_at       = NOW()
  `, [normalizedText, sampleText, suggestedIntent, occurrenceCount, confidence, !!autoApplied, learnedPattern || null]);
}

async function evaluateAutoPromotion(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const rows = await pgPool.query('claude', `
    SELECT id, text, llm_intent, promoted_to
    FROM unrecognized_intents
    WHERE created_at > NOW() - ($1::text || ' days')::interval
    ORDER BY created_at DESC
    LIMIT 500
  `, [String(AUTO_PROMOTE_WINDOW_DAYS)]);

  const matching = rows.filter(r => normalizeIntentText(r.text) === normalized);
  if (matching.length < AUTO_PROMOTE_MIN_COUNT) return null;
  if (matching.some(r => r.promoted_to)) return null;

  const counts = new Map();
  for (const row of matching) {
    if (!row.llm_intent) continue;
    counts.set(row.llm_intent, (counts.get(row.llm_intent) || 0) + 1);
  }
  if (counts.size === 0) return null;

  const [suggestedIntent, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const confidence = dominantCount / matching.length;
  const pattern = buildAutoLearnPattern(normalized);
  const sampleText = matching[0]?.text || normalized;

  await upsertPromotionCandidate({
    normalizedText: normalized,
    sampleText,
    suggestedIntent,
    occurrenceCount: matching.length,
    confidence,
    autoApplied: false,
    learnedPattern: pattern,
  });

  if (confidence < AUTO_PROMOTE_MIN_CONFIDENCE || !pattern) return null;

  const recordIds = matching.map(r => r.id);
  await promoteToIntent(normalized, suggestedIntent, pattern, recordIds);
  const candidate = await pgPool.get('claude', `
    SELECT id FROM intent_promotion_candidates WHERE normalized_text = $1 LIMIT 1
  `, [normalized]);
  await upsertPromotionCandidate({
    normalizedText: normalized,
    sampleText,
    suggestedIntent,
    occurrenceCount: matching.length,
    confidence,
    autoApplied: true,
    learnedPattern: pattern,
  });
  await logPromotionEvent({
    candidateId: candidate?.id || null,
    normalizedText: normalized,
    sampleText,
    suggestedIntent,
    eventType: 'auto_apply',
    learnedPattern: pattern,
    actor: 'system',
    metadata: { occurrenceCount: matching.length, confidence },
  });
  return { normalized, suggestedIntent, occurrenceCount: matching.length, confidence, autoApplied: true };
}

async function logUnrecognizedIntent(text, source, llmIntent) {
  try {
    await _ensureUnrecTable();
    await pgPool.run('claude', `
      INSERT INTO unrecognized_intents (text, parse_source, llm_intent)
      VALUES ($1, $2, $3)
    `, [text.slice(0, 500), source || 'unknown', llmIntent || null]);
    await evaluateAutoPromotion(text);
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
    const candidates = await pgPool.query('claude', `
      SELECT sample_text, suggested_intent, occurrence_count, confidence, auto_applied
      FROM intent_promotion_candidates
      ORDER BY last_seen_at DESC
      LIMIT 10
    `);
    if (candidates.length > 0) {
      lines.push('');
      lines.push('🤖 자동 반영/후보');
      for (const c of candidates) {
        const badge = c.auto_applied ? '✅자동반영' : '📝후보';
        lines.push(`  ${badge} [${c.occurrence_count}회 / ${(Number(c.confidence) * 100).toFixed(0)}%] "${String(c.sample_text).slice(0, 40)}" → ${c.suggested_intent}`);
      }
    }
    lines.push('\n/promote <인텐트> <패턴> 으로 학습시킬 수 있습니다.');
    return lines.join('\n');
  } catch (e) {
    return `⚠️ 미인식 이력 조회 실패: ${e.message}`;
  }
}

function parsePromotionQuery(raw = '') {
  const query = String(raw || '').trim().toLowerCase();
  const filters = { applied: null, intent: null, eventsOnly: false, eventType: null, actor: null };
  if (!query) return filters;

  if (/(applied|auto|자동|반영됨|반영된)/i.test(query)) filters.applied = true;
  if (/(pending|candidate|후보|대기)/i.test(query)) filters.applied = false;
  if (/(events|history|최근\s*변경|변경\s*이력|이력|로그)/i.test(query)) filters.eventsOnly = true;

  const intentMatch =
    query.match(/intent[:=]\s*([a-z0-9_./-]+)/i) ||
    query.match(/인텐트\s+([a-z0-9_./-]+)/i) ||
    query.match(/의도\s+([a-z0-9_./-]+)/i);
  if (intentMatch?.[1]) filters.intent = intentMatch[1].trim();

  const eventTypeMatch =
    query.match(/event[:=]\s*([a-z0-9_./-]+)/i) ||
    query.match(/이벤트\s+([a-z0-9_./-]+)/i);
  if (eventTypeMatch?.[1]) filters.eventType = eventTypeMatch[1].trim();

  const actorMatch =
    query.match(/actor[:=]\s*([a-z0-9_./-]+)/i) ||
    query.match(/주체\s+([a-z0-9_./-]+)/i);
  if (actorMatch?.[1]) filters.actor = actorMatch[1].trim();

  return filters;
}

async function buildPromotionCandidateReport(query = '') {
  try {
    await _ensureUnrecTable();
    const filters = parsePromotionQuery(query);
    const clauses = [];
    const params = [];

    if (typeof filters.applied === 'boolean') {
      params.push(filters.applied);
      clauses.push(`auto_applied = $${params.length}`);
    }
    if (filters.intent) {
      params.push(`%${filters.intent}%`);
      clauses.push(`suggested_intent ILIKE $${params.length}`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const summary = await pgPool.get('claude', `
      SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE auto_applied = true)::int AS applied_count,
        COUNT(*) FILTER (WHERE auto_applied = false)::int AS pending_count
      FROM intent_promotion_candidates
      ${whereSql}
    `, params);
    const rows = filters.eventsOnly ? [] : await pgPool.query('claude', `
      SELECT id, sample_text, suggested_intent, occurrence_count, confidence, auto_applied, updated_at
      FROM intent_promotion_candidates
      ${whereSql}
      ORDER BY auto_applied DESC, updated_at DESC
      LIMIT 20
    `, params);
    if (!filters.eventsOnly && rows.length === 0) {
      const suffix = query ? ` (${query})` : '';
      return `📝 자동 반영 후보 없음${suffix}`;
    }

    const lines = ['📝 자동 반영 후보/이력'];
    const filterBits = [];
    if (filters.applied === true) filterBits.push('자동반영만');
    if (filters.applied === false) filterBits.push('후보만');
    if (filters.intent) filterBits.push(`intent=${filters.intent}`);
    if (filters.eventsOnly) filterBits.push('최근변경만');
    if (filters.eventType) filterBits.push(`event=${filters.eventType}`);
    if (filters.actor) filterBits.push(`actor=${filters.actor}`);
    if (filterBits.length > 0) lines.push(`필터: ${filterBits.join(' | ')}`);
    if (!filters.eventsOnly) {
      lines.push(`요약: 전체 ${summary?.total_count ?? rows.length}건 | 자동반영 ${summary?.applied_count ?? 0}건 | 후보 ${summary?.pending_count ?? 0}건`);
      lines.push('');
      for (const r of rows) {
        const badge = r.auto_applied ? '✅자동반영' : '🕓후보';
        const conf = `${(Number(r.confidence) * 100).toFixed(0)}%`;
        const seen = String(r.updated_at).slice(0, 16);
        lines.push(`  ${badge} [id=${r.id} | ${r.occurrence_count}회 / ${conf}] "${String(r.sample_text).slice(0, 40)}" → ${r.suggested_intent}`);
        lines.push(`     최근: ${seen} KST`);
      }
    }

    const eventClauses = [];
    const eventParams = [];
    if (filters.eventType) {
      eventParams.push(filters.eventType);
      eventClauses.push(`event_type = $${eventParams.length}`);
    }
    if (filters.actor) {
      eventParams.push(filters.actor);
      eventClauses.push(`actor = $${eventParams.length}`);
    }
    if (filters.intent) {
      eventParams.push(`%${filters.intent}%`);
      eventClauses.push(`suggested_intent ILIKE $${eventParams.length}`);
    }
    const eventWhereSql = eventClauses.length > 0 ? `WHERE ${eventClauses.join(' AND ')}` : '';
    const events = await pgPool.query('claude', `
      SELECT event_type, sample_text, suggested_intent, actor, created_at
      FROM intent_promotion_events
      ${eventWhereSql}
      ORDER BY created_at DESC
      LIMIT 10
    `, eventParams);
    if (events.length > 0) {
      lines.push('');
      lines.push('최근 변경:');
      for (const e of events) {
        const when = String(e.created_at).slice(0, 16);
        lines.push(`  ${when} KST | ${e.event_type} | "${String(e.sample_text || '').slice(0, 28)}" → ${e.suggested_intent || '-'} (${e.actor})`);
      }
    } else if (filters.eventsOnly || filters.eventType || filters.actor) {
      lines.push('');
      lines.push('최근 변경: 없음');
    }
    lines.push('');
    lines.push(`기준: 최근 ${AUTO_PROMOTE_WINDOW_DAYS}일 ${AUTO_PROMOTE_MIN_COUNT}회+, 일치율 ${Math.round(AUTO_PROMOTE_MIN_CONFIDENCE * 100)}%+`);
    lines.push('조회: /promotions applied | /promotions pending | /promotions intent:luna_query');
    lines.push('이력: /promotions events | /promotions event:rollback | /promotions actor:master');
    lines.push('롤백: /rollback <id> 또는 /rollback <문구>');
    return lines.join('\n');
  } catch (e) {
    return `⚠️ 자동 반영 후보 조회 실패: ${e.message}`;
  }
}

async function rollbackPromotionTarget(target = '') {
  const raw = String(target || '').trim();
  if (!raw) return '⚠️ 롤백할 문구 또는 id가 필요합니다.\n예) /rollback 12';

  const candidateId = Number.parseInt(raw, 10);
  const normalized = normalizeIntentText(raw);

  await _ensureUnrecTable();
  const row = Number.isFinite(candidateId)
    ? await pgPool.get('claude', `
        SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
        FROM intent_promotion_candidates
        WHERE id = $1
        LIMIT 1
      `, [candidateId])
    : await pgPool.get('claude', `
        SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
        FROM intent_promotion_candidates
        WHERE normalized_text = $1 OR sample_text = $2
        LIMIT 1
      `, [normalized, raw]);
  if (!row) return `⚠️ "${raw}" 에 대한 자동 반영 후보를 찾지 못했습니다.`;

  const learnPath = path.join(os.homedir(), '.openclaw', 'workspace', 'nlp-learnings.json');
  let learnings = [];
  try {
    if (fs.existsSync(learnPath)) learnings = JSON.parse(fs.readFileSync(learnPath, 'utf8'));
  } catch {}

  const before = learnings.length;
  learnings = learnings.filter(item => {
    if (row.learned_pattern && item.re === row.learned_pattern) return false;
    if (item.re === row.sample_text) return false;
    return true;
  });
  if (learnings.length !== before) {
    fs.writeFileSync(learnPath, JSON.stringify(learnings, null, 2));
  }

  await pgPool.run('claude', `
    UPDATE unrecognized_intents
    SET promoted_to = NULL
    WHERE promoted_to = $1
      AND lower(regexp_replace(text, '[^[:alnum:][:space:]]', ' ', 'g')) LIKE '%' || $2 || '%'
  `, [row.suggested_intent, normalized]);

  await pgPool.run('claude', `
    UPDATE intent_promotion_candidates
    SET auto_applied = FALSE,
        learned_pattern = NULL,
        updated_at = NOW()
    WHERE id = $1
  `, [row.id]);
  await logPromotionEvent({
    candidateId: row.id,
    normalizedText: row.normalized_text,
    sampleText: row.sample_text,
    suggestedIntent: row.suggested_intent,
    eventType: 'rollback',
    learnedPattern: row.learned_pattern,
    actor: 'master',
    metadata: { rollbackTarget: raw },
  });

  return [
    `↩️ 자동 반영 롤백 완료`,
    `id: ${row.id}`,
    `문구: "${row.sample_text}"`,
    `인텐트: ${row.suggested_intent}`,
  ].join('\n');
}

async function promoteToIntent(text, toIntent, pattern, recordIds = []) {
  try {
    await _ensureUnrecTable();
    // DB에 promoted_to 기록
    if (recordIds.length > 0) {
      await pgPool.run('claude', `
        UPDATE unrecognized_intents
        SET promoted_to = $1
        WHERE id = ANY($2::int[]) AND promoted_to IS NULL
      `, [toIntent, recordIds]);
    } else if (text) {
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
    await logPromotionEvent({
      normalizedText: normalizeIntentText(text),
      sampleText: text,
      suggestedIntent: toIntent,
      eventType: recordIds.length > 0 ? 'promote_batch' : 'promote_manual',
      learnedPattern: re,
      actor: recordIds.length > 0 ? 'system' : 'master',
      metadata: { recordCount: recordIds.length || 1 },
    });
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
      const raw = await waitForCommandResult(cmdId, 300000);
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

function stripAnsi(text = '') {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function summarizeSpeedTestOutput(stdout = '') {
  const plain   = stripAnsi(stdout);
  const lines   = plain.split('\n').map(line => line.trimEnd());
  const current = lines.find(line => line.includes('현재 primary:'))?.replace(/^.*현재 primary:\s*/, '').trim();
  const fastest = lines.find(line => line.includes('최고 속도:'))?.replace(/^.*최고 속도:\s*/, '').trim();
  const start   = lines.findIndex(line => line.includes('📊 결과 (TTFT 기준 정렬)'));
  const topRows = start >= 0
    ? lines.slice(start + 2).filter(line => line.trim()).filter(line => !/^─+$/.test(line.trim())).slice(0, 3)
    : [];

  const out = ['🚀 LLM 속도 테스트 결과'];
  if (current) out.push(`현재 primary: ${current}`);
  if (fastest) out.push(`최고 속도: ${fastest}`);
  if (topRows.length > 0) {
    out.push('');
    out.push('상위 결과:');
    out.push(...topRows.map(line => `  ${line}`));
  }
  if (!current && !fastest && topRows.length === 0) {
    out.push('결과를 요약하지 못했습니다. /tmp/speed-test.log 를 확인하세요.');
  }
  return out.join('\n');
}

function tailFileSafe(filePath, limit = 40) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

function summarizeLogLines(lines = []) {
  if (!lines.length) return '정상';
  const joined = lines.join('\n');
  if (/API rate limit reached/i.test(joined)) return 'API rate limit';
  if (/stale-socket/i.test(joined)) return 'stale-socket 재시작';
  if (/ECONNREFUSED/i.test(joined)) return 'DB/네트워크 연결 실패';
  if (/items is not iterable/i.test(joined)) return '반복 처리 오류';
  return lines[lines.length - 1].slice(0, 120);
}

function buildSystemLogSummary(rawText = '') {
  const target = /gateway|게이트웨이|telegram|텔레그램/i.test(rawText)
    ? 'gateway'
    : /mainbot|제이|orchestrator|오케스트레이터/i.test(rawText)
      ? 'mainbot'
      : 'all';

  const targets = target === 'all'
    ? [
        { label: '제이 mainbot', out: path.join(os.homedir(), '.openclaw/logs/mainbot.log'), err: path.join(os.homedir(), '.openclaw/logs/mainbot-error.log') },
        { label: 'OpenClaw gateway', out: path.join(os.homedir(), '.openclaw/logs/gateway.log'), err: path.join(os.homedir(), '.openclaw/logs/gateway.err.log') },
      ]
    : target === 'gateway'
      ? [{ label: 'OpenClaw gateway', out: path.join(os.homedir(), '.openclaw/logs/gateway.log'), err: path.join(os.homedir(), '.openclaw/logs/gateway.err.log') }]
      : [{ label: '제이 mainbot', out: path.join(os.homedir(), '.openclaw/logs/mainbot.log'), err: path.join(os.homedir(), '.openclaw/logs/mainbot-error.log') }];

  const lines = ['🧾 최근 시스템 로그'];
  for (const item of targets) {
    const outLines = tailFileSafe(item.out, 40);
    const errLines = tailFileSafe(item.err, 40);
    const summary = errLines.length ? summarizeLogLines(errLines) : '정상';
    lines.push(`${item.label}: ${summary}`);
    if (!errLines.length && outLines.length) {
      lines.push(`  최근 출력: ${outLines[outLines.length - 1].slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

async function runSpeedTestDirect() {
  const root = path.join(__dirname, '..', '..', '..');
  const node = process.execPath;
  const script = path.join(root, 'scripts', 'speed-test.js');

  return await new Promise((resolve) => {
    const child = spawn(node, [script, '--runs=1'], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve('⏱ 속도 테스트가 90초 내 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.');
    }, 90_000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`⚠️ 속도 테스트 실행 실패: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = stripAnsi(stderr || stdout).trim().split('\n').filter(Boolean).slice(-4).join('\n');
        resolve(`⚠️ 속도 테스트 실패${msg ? `\n${msg}` : ''}`);
        return;
      }
      resolve(summarizeSpeedTestOutput(stdout));
    });
  });
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
  if (!rawResult) return '⏱ 클로드팀 응답 지연 (타임아웃). 팀장 비정상으로 단정하진 않습니다.';
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

    case 'speed_test': {
      await notify('⏳ LLM 속도 테스트 실행 중...');
      return await runSpeedTestDirect();
    }

    case 'system_logs':
      return buildSystemLogSummary(msg.text || '');

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

    case 'luna_confirm': {
      const currentMode = await shadowMode.getTeamMode('luna');
      if (currentMode === 'confirmation') return '⚠️ 이미 confirmation 모드입니다.';
      const rate = await shadowMode.getMatchRate('luna', null, 7);
      if (rate.total < 10) {
        return `❌ 샘플 부족 (${rate.total}건 — 최소 10건 필요)\n먼저 shadow 모드로 더 많은 데이터를 수집하세요.`;
      }
      if (rate.matchRate < 0.80) {
        return `❌ 일치율 미달 (${(rate.matchRate * 100).toFixed(1)}% — 최소 80% 필요)\n/luna_analysis 로 분석 후 프롬프트 튜닝 필요.`;
      }
      await shadowMode.setTeamMode('luna', 'confirmation', 'master');
      return [
        '✅ 루나팀 confirmation 모드 전환 완료',
        `이전 모드: ${currentMode}`,
        `최근 7일 일치율: ${(rate.matchRate * 100).toFixed(1)}% (${rate.total}건)`,
        '',
        '⚠️ 이제 LLM이 1차 판단, 규칙엔진이 검증합니다.',
        '/luna_shadow — shadow 모드로 복귀',
      ].join('\n');
    }

    case 'luna_shadow': {
      const currentMode = await shadowMode.getTeamMode('luna');
      if (currentMode === 'shadow') return '⚠️ 이미 shadow 모드입니다.';
      await shadowMode.setTeamMode('luna', 'shadow', 'master');
      return [
        '✅ 루나팀 shadow 모드 복귀 완료',
        `이전 모드: ${currentMode}`,
        '',
        '이제 규칙엔진이 실행되고 LLM은 비교만 합니다.',
        '/luna_confirm — confirmation 모드로 전환',
      ].join('\n');
    }

    case 'luna_analysis': {
      await notify('⏳ 루나팀 전환 분석 중...');
      const [allTime, recent7, recent3] = await Promise.all([
        shadowMode.getMatchRate('luna', null, 30),
        shadowMode.getMatchRate('luna', null, 7),
        shadowMode.getMatchRate('luna', null, 3),
      ]);
      const mismatches  = await shadowMode.getMismatches('luna', null, 14);
      const currentMode = await shadowMode.getTeamMode('luna');

      const fmtRate = (r, n) => r === null ? 'N/A' : `${(r * 100).toFixed(1)}% (${n}건)`;

      const rate7 = recent7.matchRate;
      let rec;
      if (rate7 === null || recent7.total < 10) {
        rec = '❓ DATA_INSUFFICIENT — 샘플 부족, 추가 관측 필요';
      } else if (rate7 >= 0.90) {
        rec = '✅ READY — /luna_confirm 으로 전환 가능';
      } else if (rate7 >= 0.80) {
        rec = '⚠️ TUNING — 프롬프트 튜닝 후 재검토 (목표 90%+)';
      } else {
        rec = '❌ HOLD — 기존 규칙엔진 유지, 추가 분석 필요';
      }

      const mismatchLines = mismatches.slice(0, 3).map(m => {
        const rule = m.rule_result?.decision ?? '-';
        const llm  = m.llm_result?.decision  ?? '-';
        return `  • 규칙=${rule} vs LLM=${llm}`;
      });

      return [
        '💰 루나팀 Shadow 전환 분석',
        '════════════════════════',
        `현재 모드: ${currentMode}`,
        '',
        `전체(30일): ${fmtRate(allTime.matchRate, allTime.total)}`,
        `최근  7일:  ${fmtRate(recent7.matchRate, recent7.total)}`,
        `최근  3일:  ${fmtRate(recent3.matchRate, recent3.total)}`,
        '',
        `불일치 ${mismatches.length}건 (최근 14일)`,
        ...(mismatchLines.length > 0 ? mismatchLines : ['  (없음)']),
        '',
        `📋 판단: ${rec}`,
      ].join('\n');
    }

    case 'dynamic_tpsl_on':
    case 'dynamic_tpsl_off':
    case 'dynamic_tpsl_status': {
      // 루나팀 ATR 기반 동적 TP/SL 토글 / 상태 조회
      const configPath = path.join(__dirname, '..', '..', '..', 'investment', 'config.yaml');
      try {
        const yaml   = fs.readFileSync(configPath, 'utf8');
        const match  = yaml.match(/^dynamic_tp_sl_enabled\s*:\s*(.+)$/m);
        const current = match ? match[1].trim() === 'true' : false;

        if (intent === 'dynamic_tpsl_status') {
          return current
            ? '📊 동적 TP/SL 상태: ✅ 활성화\nATR 기반 동적 TP/SL 적용 중'
            : '📊 동적 TP/SL 상태: ⛔ 비활성화\n고정 TP +6% / SL -3% 적용 중';
        }

        const enable = intent === 'dynamic_tpsl_on';
        const updated = yaml.replace(
          /^(dynamic_tp_sl_enabled\s*:\s*).*$/m,
          `$1${enable}`
        );
        fs.writeFileSync(configPath, updated);
        return enable
          ? '✅ 동적 TP/SL 활성화\nATR 기반 동적 TP/SL이 헤파이스토스에 적용됩니다.\n⚠️ 실투자 포지션에 즉시 영향 — 확인 필요'
          : '✅ 동적 TP/SL 비활성화\n고정 TP +6% / SL -3%로 복귀합니다.';
      } catch (e) {
        return `❌ config.yaml 수정 실패: ${e.message}`;
      }
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
      if (!raw) return '⏱ 클로드 응답 지연 (타임아웃). 팀장 비정상으로 단정하진 않습니다.';
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

    case 'graduation_scan': {
      try {
        await notify('⏳ LLM 졸업 후보 탐색 중...');
        const allCandidates = [];
        for (const team of ['ska', 'claude-lead', 'luna']) {
          const c = await llmGraduation.findGraduationCandidates(team, 20, 0.90);
          allCandidates.push(...(c || []));
        }
        if (allCandidates.length === 0) return '✅ 현재 졸업 후보 없음 (샘플 부족 또는 일치율 미달)';
        const lines = [
          `🎓 LLM 졸업 후보 ${allCandidates.length}건`,
          '⚠️ 마스터 승인 후에만 적용 가능',
          '',
          ...allCandidates.slice(0, 8).map(c =>
            `  • id=? [${c.team}/${c.context}] ${c.decision} — ${c.matchRate} (n=${c.total})`
          ),
          '',
          '/graduate_start <id> — 검증 시작 (2주 병렬 테스트)',
          '/graduate_approve <id> — 최종 승인',
        ];
        // ID 조회
        const rows = await pgPool.query('claude', `
          SELECT id, team, context, predicted_decision AS decision, match_rate, status
          FROM graduation_candidates
          WHERE status = 'candidate'
          ORDER BY match_rate DESC LIMIT 8
        `);
        const withId = rows.map(r =>
          `  • id=${r.id} [${r.team}/${r.context}] ${r.decision} — ${(r.match_rate * 100).toFixed(1)}%`
        );
        return [
          `🎓 LLM 졸업 후보 ${allCandidates.length}건`,
          '⚠️ 마스터 승인 후에만 적용 가능',
          '',
          ...withId,
          '',
          '/graduate_start <id> — 검증 시작 (2주 병렬 테스트)',
          '/graduate_approve <id> — 최종 승인',
        ].join('\n');
      } catch (e) { return `⚠️ 졸업 탐색 실패: ${e.message}`; }
    }

    case 'graduate_start': {
      const id = parseInt(args.id || '', 10);
      if (isNaN(id)) return '⚠️ ID가 필요합니다.\n예) /graduate_start 3';
      try {
        const result = await llmGraduation.startVerification(id);
        return [
          `🔄 졸업 검증 시작: id=${result.id}`,
          `팀: ${result.team} / 맥락: ${result.context}`,
          `판단: ${result.decision}`,
          '',
          '2주간 shadow_log에서 병렬 비교합니다.',
          '검증 완료 후 /graduate_approve <id> 로 최종 승인하세요.',
        ].join('\n');
      } catch (e) { return `⚠️ 검증 시작 실패: ${e.message}`; }
    }

    case 'graduate_approve': {
      const id = parseInt(args.id || '', 10);
      if (isNaN(id)) return '⚠️ ID가 필요합니다.\n예) /graduate_approve 3';
      try {
        const result = await llmGraduation.approveGraduation(id, 'master');
        return [
          `✅ LLM 졸업 승인 완료: id=${result.id}`,
          '이제 이 패턴에는 LLM 호출 없이 규칙이 적용됩니다.',
          '',
          '⚠️ shadow_log 모니터링은 계속됩니다.',
          '불일치 20%+ 시 자동 복귀합니다 (주간 검증).',
        ].join('\n');
      } catch (e) { return `⚠️ 졸업 승인 실패: ${e.message}`; }
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
      const raw   = await waitForCommandResult(cmdId, 180000);
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

    case 'promotion_candidates':
      return await buildPromotionCandidateReport(args.query || msg.text || '');

    case 'promotion_rollback':
      return await rollbackPromotionTarget(args.target || msg.text || '');

    case 'promote_intent': {
      const { intent: toIntent, pattern, text: uText } = args;
      if (!toIntent || (!pattern && !uText)) {
        return '⚠️ 사용법: /promote <인텐트> <패턴>\n예) /promote ska_query 오늘 방문객 몇 명이야';
      }
      await promoteToIntent(uText || pattern, toIntent, pattern || uText);
      return `✅ "${(uText || pattern).slice(0, 40)}" → ${toIntent} 학습 등록 완료\nnlp-learnings.json 업데이트됨 (5분 내 자동 반영)`;
    }

    // ── 블로그팀 커리큘럼 ─────────────────────────────────────────────

    case 'curriculum_status': {
      const cp = _getCP();
      if (!cp) return '⚠️ curriculum-planner 모듈 없음 (blog 봇 미설치)';
      try {
        const [series, ending] = await Promise.all([
          cp.getActiveSeries(),
          cp.checkSeriesEndingSoon(),
        ]);
        if (!series) return '📚 활성 커리큘럼 시리즈 없음\n/curriculum_approve 로 새 시리즈 제안을 받으세요.';
        const lines = [
          `📚 커리큘럼 현황`,
          `  시리즈: ${series.series_name}`,
          `  전체: ${series.total_lectures}강`,
          `  상태: ${series.status}`,
          `  시작일: ${String(series.start_date).slice(0, 10)}`,
        ];
        if (ending?.needsPlanning) {
          lines.push('');
          lines.push(`⚠️ 잔여 ${ending.remainingLectures}강 — 차기 시리즈 제안 진행 중`);
          lines.push('  /curriculum_approve 로 확인하세요.');
        } else if (ending) {
          lines.push(`  잔여: ${ending.remainingLectures}강`);
        }
        return lines.join('\n');
      } catch (e) { return `⚠️ 커리큘럼 조회 오류: ${e.message}`; }
    }

    case 'curriculum_approve': {
      const cp = _getCP();
      if (!cp) return '⚠️ curriculum-planner 모듈 없음 (blog 봇 미설치)';

      const input = (args.topic || msg.text || '').trim();
      const num   = parseInt(input, 10);

      // 숫자 1~3 회신: DB candidate 목록에서 선택
      if (!isNaN(num) && num >= 1 && num <= 3) {
        try {
          const candidates = await pgPool.query('blog', `
            SELECT id, series_name, total_lectures, proposed_at
            FROM blog.curriculum_series
            WHERE status = 'candidate'
            ORDER BY proposed_at DESC
            LIMIT 3
          `);
          if (!candidates || candidates.length === 0) {
            return '⚠️ 승인할 커리큘럼 후보가 없습니다.\n블로그팀이 새 후보를 제안할 때까지 기다려 주세요.';
          }
          const chosen = candidates[num - 1];
          if (!chosen) return `⚠️ ${num}번 후보가 없습니다. (후보 수: ${candidates.length})`;

          await notify(`⏳ "${chosen.series_name}" 커리큘럼 생성 중... (최대 2분)`);
          await cp.generateCurriculum(chosen.series_name, chosen.total_lectures || 100);
          await cp.transitionSeries();

          return [
            `✅ 커리큘럼 생성 완료!`,
            `  시리즈: ${chosen.series_name}`,
            `  강의 수: ${chosen.total_lectures || 100}강`,
            ``,
            `내일부터 새 시리즈로 블로그 포스팅이 시작됩니다.`,
          ].join('\n');
        } catch (e) {
          return `⚠️ 커리큘럼 생성 실패: ${e.message}`;
        }
      }

      // 직접 주제명 입력: generateCurriculum 직접 호출
      if (input && input.length > 2 && isNaN(num)) {
        // "/curriculum_approve" 슬래시 자체만 왔을 때는 후보 목록 조회
        const isSlashOnly = input === '/curriculum_approve';
        if (!isSlashOnly) {
          try {
            await notify(`⏳ "${input}" 커리큘럼 생성 중... (최대 2분)`);
            await cp.generateCurriculum(input, 100);
            await cp.transitionSeries();
            return [
              `✅ "${input}" 커리큘럼 생성 완료!`,
              `  강의 수: 100강`,
              ``,
              `내일부터 새 시리즈로 포스팅이 시작됩니다.`,
            ].join('\n');
          } catch (e) {
            return `⚠️ 커리큘럼 생성 실패: ${e.message}`;
          }
        }
      }

      // 후보 목록 조회 (슬래시 단독 or 빈 입력)
      try {
        const candidates = await pgPool.query('blog', `
          SELECT series_name, total_lectures, proposed_at
          FROM blog.curriculum_series
          WHERE status = 'candidate'
          ORDER BY proposed_at DESC
          LIMIT 3
        `);
        if (!candidates || candidates.length === 0) {
          return '⚠️ 현재 승인 대기 중인 커리큘럼 후보가 없습니다.\n잔여 강의가 7강 이하가 되면 자동으로 제안이 전송됩니다.';
        }
        const lines = [`📚 승인 대기 커리큘럼 후보 (1~${candidates.length} 중 선택)`];
        candidates.forEach((c, i) => {
          lines.push(`  ${i + 1}. ${c.series_name} (${c.total_lectures || 100}강)`);
        });
        lines.push('');
        lines.push('회신: 1, 2, 또는 3');
        lines.push('또는 직접 주제 입력: /curriculum_approve Python기초_100');
        return lines.join('\n');
      } catch (e) {
        return `⚠️ 후보 목록 조회 실패: ${e.message}`;
      }
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
