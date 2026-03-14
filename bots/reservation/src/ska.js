#!/usr/bin/env node
'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * src/ska.js — 스카 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (5초 간격)
 *   - 명령 처리: query_reservations, query_today_stats, query_alerts, restart_andy, restart_jimmy
 *   - 결과를 bot_commands.status='done', result=JSON으로 업데이트
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync, execFileSync, spawn } = require('child_process');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const rag      = require('../../../packages/core/lib/rag-safe');
const { safeWriteFile } = require('../../../packages/core/lib/file-guard');
const {
  AUTO_PROMOTE_DEFAULTS,
  normalizeIntentText,
  buildAutoLearnPattern,
  evaluateAutoPromoteDecision,
} = require('../../../packages/core/lib/intent-core');
const {
  ensureIntentTables,
  addLearnedPattern,
  getNamedIntentLearningPath,
  insertUnrecognizedIntent,
  getRecentUnrecognizedIntents,
  upsertPromotionCandidate,
  logPromotionEvent,
  findPromotionCandidateIdByNormalized,
  markUnrecognizedPromoted,
} = require('../../../packages/core/lib/intent-store');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME       = '스카';
const BOT_ID         = 'ska';
const IDENTITY_FILE  = path.join(__dirname, '../context/COMMANDER_IDENTITY.md');
const PROJECT_ROOT   = path.join(os.homedir(), 'projects', 'ai-agent-system');
const NLP_LEARNINGS_PATH = getNamedIntentLearningPath('jay');
const TG_MAX_CHARS = 3500;

// ─── 정체성 로더 (LLM 없이 파일 기반) ──────────────────────────────
// 봇이 자신의 역할·임무를 인식하고 유지하기 위한 핵심 메커니즘.
// 향후 LLM 추가 시 BOT_IDENTITY를 시스템 프롬프트에 주입.

let BOT_IDENTITY = {
  name:    '스카 커맨더',
  team:    '스카팀',
  role:    '스카팀 팀장 — 스터디카페 운영 관리 지휘',
  mission: 'bot_commands 폴링(5초), 예약·매출·알람 조회, 앤디·지미 재시작, 팀원 정체성 점검',
};

function loadBotIdentity() {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) {
      console.log(`[스카] 🎭 정체성: ${BOT_IDENTITY.role} (기본값)`);
      return;
    }
    const content = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const roleM    = content.match(/## 역할\n+([\s\S]*?)(?=\n## )/);
    const missionM = content.match(/## 임무\n+([\s\S]*?)(?=\n## )/);
    if (roleM)    BOT_IDENTITY.role    = roleM[1].trim().split('\n')[0];
    if (missionM) BOT_IDENTITY.mission = missionM[1].trim().replace(/^- /gm, '').split('\n')[0];
    console.log(`[스카] 🎭 정체성 로드: ${BOT_IDENTITY.role}`);
  } catch (e) {
    console.error(`[스카] 정체성 로드 실패:`, e.message);
  }
}

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'ska.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try { process.kill(Number(old), 0); console.error(`${BOT_NAME} 이미 실행 중 (PID: ${old})`); process.exit(1); }
    catch { fs.unlinkSync(LOCK_PATH); }
  }
  safeWriteFile(LOCK_PATH, String(process.pid), 'ska');
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── DB ──────────────────────────────────────────────────────────────
// claude 스키마: bot_commands (제이팀)
// reservation 스키마: reservations, daily_summary, alerts (Phase 3에서 마이그레이션 완료)

// ─── 팀원 정체성 점검·학습 ───────────────────────────────────────────

const BOT_ID_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'bot-identities');

const SKA_TEAM = [
  {
    id: 'andy', name: '앤디', launchd: 'ai.ska.naver-monitor',
    team: '스카팀',
    role: '네이버 스마트플레이스 모니터링',
    mission: '5분마다 예약 현황 수집 및 이상 감지 알람 발송',
  },
  {
    id: 'jimmy', name: '지미', launchd: 'ai.ska.kiosk-monitor',
    team: '스카팀',
    role: '픽코 키오스크 예약 모니터링',
    mission: '키오스크 신규 예약 감지 및 알람 발송',
  },
  {
    id: 'rebecca', name: '레베카', launchd: null,
    team: '스카팀',
    role: '매출 예측 분석',
    mission: '과거 데이터 기반 매출·입장수 예측 모델 실행',
  },
  {
    id: 'eve', name: '이브', launchd: null,
    team: '스카팀',
    role: '공공API 환경요소 수집',
    mission: '공휴일·날씨·학사·축제 데이터 수집 및 저장',
  },
];

function inspectLaunchdService(label) {
  try {
    const service = `gui/${process.getuid()}/${label}`;
    const out = execFileSync('launchctl', ['print', service], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const stateMatch = out.match(/^\s*state = ([^\n]+)$/m);
    const exitMatch = out.match(/^\s*last exit code = ([^\n]+)$/m);
    const pidMatch = out.match(/^\s*pid = ([^\n]+)$/m);
    return {
      ok: true,
      state: stateMatch?.[1]?.trim() || 'unknown',
      lastExitCode: exitMatch?.[1]?.trim() || '',
      pid: pidMatch?.[1]?.trim() || '',
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
    };
  }
}

function checkSkaTeamIdentity() {
  if (!fs.existsSync(BOT_ID_DIR)) fs.mkdirSync(BOT_ID_DIR, { recursive: true });

  const results = [];
  for (const member of SKA_TEAM) {
    const issues  = [];
    let   trained = false;

    // 1. 프로세스 상태 (launchd 서비스 있는 봇만)
    if (member.launchd) {
      const inspected = inspectLaunchdService(member.launchd);
      if (!inspected.ok) {
        issues.push('프로세스 상태 확인 실패');
      } else if (inspected.state !== 'running') {
        const exitInfo = inspected.lastExitCode ? ` (exit=${inspected.lastExitCode})` : '';
        issues.push(`프로세스 비실행${exitInfo}`);
      }
    }

    // 2. 정체성 파일 체크 (없으면 생성, 30일 초과면 갱신)
    const idFile = path.join(BOT_ID_DIR, `${member.id}.json`);
    if (!fs.existsSync(idFile)) {
      safeWriteFile(idFile, JSON.stringify({
        name: member.name, team: member.team,
        role: member.role, mission: member.mission,
        launchd: member.launchd, updated_at: new Date().toISOString(),
      }, null, 2), 'ska');
      trained = true;
      issues.push('→ 정체성 파일 생성');
    } else {
      const data    = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      const ageMs   = Date.now() - new Date(data.updated_at || 0).getTime();
      const missing = ['name', 'role', 'mission'].filter(f => !data[f]);
      if (missing.length > 0 || ageMs > 30 * 24 * 3600 * 1000) {
        if (missing.length > 0) issues.push(`누락 필드: ${missing.join(', ')}`);
        Object.assign(data, { name: member.name, team: member.team, role: member.role, mission: member.mission, updated_at: new Date().toISOString() });
        safeWriteFile(idFile, JSON.stringify(data, null, 2), 'ska');
        trained = true;
        issues.push('→ 정체성 갱신');
      }
    }

    results.push({ name: member.name, issues, trained });
  }

  // 콘솔 요약
  const problems = results.filter(r => r.issues.some(i => !i.startsWith('→')));
  if (problems.length > 0) {
    console.log(`[스카] 팀원 정체성 점검: ${problems.length}건 이슈`);
    for (const r of problems) console.log(`  ${r.name}: ${r.issues.filter(i => !i.startsWith('→')).join(' | ')}`);
  } else {
    console.log(`[스카] 팀원 정체성 점검: 정상`);
  }
  return results;
}

// ─── RAG 유틸 ────────────────────────────────────────────────────────

/**
 * 예약 이상 발생 시 과거 유사 사례 검색
 * @param {string} issueType — 알람 타입 (예: 'mismatch', 'sync_error')
 * @param {string} detail    — 이슈 상세 키워드
 */
async function searchPastCases(issueType, detail) {
  try {
    const query = `${issueType} ${detail}`.slice(0, 200);
    const hits  = await rag.search('reservations', query, { limit: 3, threshold: 0.6 });
    if (!hits || hits.length === 0) return null;
    return hits.map(h => ({
      content: (h.content || '').slice(0, 150),
      date:    h.created_at ? new Date(h.created_at).toLocaleDateString('ko-KR') : '',
    }));
  } catch {
    return null;
  }
}

/**
 * 알람 처리 결과를 RAG에 기록 (향후 유사 사례 검색에 활용)
 */
async function storeAlertContext(issueType, detail, resolution) {
  try {
    await rag.store(
      'reservations',
      `[알람 처리] ${issueType} | ${detail} | 조치: ${resolution}`,
      { type: issueType, detail, resolution },
      'ska-commander',
    );
  } catch { /* 무시 */ }
}

async function saveLearning(entry) {
  try {
    const normalizedText = normalizeIntentText(entry.original_text || entry.re || '');
    const learnedPattern = entry.re || buildAutoLearnPattern(normalizedText);
    const intent = entry.intent;
    const confidence = Number(entry.confidence || 0.95);
    if (!normalizedText || !intent || !learnedPattern) return;

    await insertUnrecognizedIntent(pgPool, {
      schema: 'ska',
      text: entry.original_text || entry.re,
      parseSource: 'llm',
      llmIntent: intent,
    });

    const rows = await getRecentUnrecognizedIntents(pgPool, {
      schema: 'ska',
      windowDays: AUTO_PROMOTE_DEFAULTS.windowDays,
      limit: 500,
    });

    const matching = rows.filter(row =>
      normalizeIntentText(row.text) === normalizedText &&
      String(row.llm_intent || '') === String(intent)
    );

    await upsertPromotionCandidate(pgPool, {
      schema: 'ska',
      normalizedText,
      sampleText: entry.original_text || entry.re,
      suggestedIntent: intent,
      occurrenceCount: matching.length,
      confidence,
      autoApplied: false,
      learnedPattern,
    });

    const decision = evaluateAutoPromoteDecision({
      intent,
      occurrenceCount: matching.length,
      confidence,
      pattern: learnedPattern,
      team: 'ska',
    });

    const candidate = await findPromotionCandidateIdByNormalized(pgPool, {
      schema: 'ska',
      normalizedText,
    });

    if (!decision.allowed) {
      await logPromotionEvent(pgPool, {
        schema: 'ska',
        candidateId: candidate?.id || null,
        normalizedText,
        sampleText: entry.original_text || entry.re,
        suggestedIntent: intent,
        eventType: decision.reason === 'unsafe_intent' ? 'auto_blocked' : 'candidate_seen',
        learnedPattern,
        actor: 'ska-commander',
        metadata: {
          reason: decision.reason,
          threshold: decision.threshold,
          occurrenceCount: matching.length,
          confidence,
          source: 'analyze_unknown',
        },
      });
      return;
    }

    const patternResult = addLearnedPattern({
      pattern: entry.re,
      intent,
      filePath: NLP_LEARNINGS_PATH,
    });

    await markUnrecognizedPromoted(pgPool, {
      schema: 'ska',
      intent,
      text: entry.original_text || entry.re,
    });

    await upsertPromotionCandidate(pgPool, {
      schema: 'ska',
      normalizedText,
      sampleText: entry.original_text || entry.re,
      suggestedIntent: intent,
      occurrenceCount: matching.length,
      confidence,
      autoApplied: true,
      learnedPattern,
    });

    await logPromotionEvent(pgPool, {
      schema: 'ska',
      candidateId: candidate?.id || null,
      normalizedText,
      sampleText: entry.original_text || entry.re,
      suggestedIntent: intent,
      eventType: patternResult.changed ? 'auto_apply' : 'candidate_seen',
      learnedPattern,
      actor: 'ska-commander',
      metadata: {
        reason: entry.reason || '',
        source: 'analyze_unknown',
        threshold: decision.threshold,
        occurrenceCount: matching.length,
        confidence,
      },
    });

    if (patternResult.changed) {
      console.log(`[스카] NLP 패턴 학습: /${entry.re}/ → ${intent}`);
    }
  } catch (e) {
    console.error(`[스카] NLP 학습 저장 실패:`, e.message);
  }
}

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 오늘 예약 현황 조회
 */
async function handleQueryReservations(args) {
  const date = args.date || kst.today();
  try {
    const rows = await pgPool.query('reservation', `
      SELECT name_enc, date, start_time, end_time, room, status
      FROM reservations
      WHERE date = $1
      ORDER BY start_time
    `, [date]);

    if (rows.length === 0) {
      return { ok: true, date, count: 0, message: `${date} 예약 없음` };
    }

    const list = rows.map(r =>
      `${r.start_time}~${r.end_time} [${r.room}] ${r.status}`
    );
    return { ok: true, date, count: rows.length, reservations: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 오늘 매출/예약수 조회
 */
async function handleQueryTodayStats(args) {
  const date = args.date || kst.today();
  try {
    const summary = await pgPool.get('reservation', `
      SELECT total_amount, entries_count FROM daily_summary WHERE date = $1
    `, [date]);

    if (!summary) {
      return { ok: true, date, message: `${date} 매출 데이터 없음` };
    }

    return {
      ok: true,
      date,
      total_amount: summary.total_amount,
      entries_count: summary.entries_count,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 미해결 알람 조회 (RAG 과거 사례 포함)
 */
async function handleQueryAlerts(args) {
  try {
    const limit = args.limit || 10;
    const rows = await pgPool.query('reservation', `
      SELECT type, title, message, timestamp
      FROM alerts
      WHERE resolved = 0
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);

    // RAG: 첫 번째 알람과 유사한 과거 사례 검색
    let pastCases = null;
    if (rows.length > 0) {
      pastCases = await searchPastCases(rows[0].type || '알람', rows[0].title || '');
    }

    return { ok: true, count: rows.length, alerts: rows, past_cases: pastCases };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 알람 해결 결과 RAG 저장 (제이가 처리 완료 보고 시 호출)
 */
async function handleStoreResolution(args) {
  const { issueType = '알람', detail = '', resolution = '처리 완료' } = args;
  try {
    await storeAlertContext(issueType, detail, resolution);
    return { ok: true, message: 'RAG 저장 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 앤디 (네이버 모니터) 재시작
 */
function handleRestartAndy() {
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.naver-monitor`], {
      encoding: 'utf8',
      timeout: 30000,
    });
    return { ok: true, message: '앤디 재시작 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 지미 (키오스크 모니터) 재시작
 */
function handleRestartJimmy() {
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.kiosk-monitor`], {
      encoding: 'utf8',
      timeout: 30000,
    });
    return { ok: true, message: '지미 재시작 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function runClaudeAnalyzePrompt(prompt, {
  cwd = PROJECT_ROOT,
  timeout = 120000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`timeout ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function handleAnalyzeUnknown(args) {
  const text = (args.text || '').trim();
  if (!text) return { ok: false, error: '분석할 텍스트 없음' };

  const prompt = `너는 AI 봇 시스템 제이(Jay)의 NLP 개선 담당이다.
제이가 처리하지 못한 사용자 메시지: "${text}"

사용 가능한 인텐트 목록:
- status              : 전체 시스템 현황 조회
- ska_query  command=query_reservations : 오늘 예약 현황·목록
- ska_query  command=query_today_stats  : 오늘 매출·입장 통계
- ska_query  command=query_alerts       : 미해결 알람 목록
- ska_action command=restart_andy       : 앤디(네이버 모니터) 재시작
- ska_action command=restart_jimmy      : 지미(키오스크 모니터) 재시작
- luna_action command=pause_trading     : 거래 일시정지
- luna_action command=resume_trading    : 거래 재개
- luna_query  command=force_report      : 투자 리포트 즉시 발송
- luna_query  command=get_status        : 루나팀 상태·잔고 조회
- claude_action command=run_check       : 덱스터 기본 점검
- claude_action command=run_full        : 덱스터 전체 점검
- claude_action command=run_fix         : 덱스터 자동 수정
- claude_action command=daily_report    : 덱스터 일일 보고
- claude_action command=run_archer      : 아처 기술 트렌드 분석
- claude_ask  query=<질문내용>           : 클로드 AI에게 직접 질문
- cost    : LLM 비용·토큰 사용량
- brief   : 야간 보류 알람 브리핑
- queue   : 알람 큐 최근 10건
- mute    : 무음 설정 (target, duration)
- unmute  : 무음 해제
- mutes   : 무음 목록
- help    : 도움말
- unknown : 어디에도 해당 없음

할 일:
1. 사용자 메시지의 의도를 파악한다.
2. 가장 적합한 인텐트를 선택한다. 없으면 null.
3. 사용자에게 전달할 자연스러운 한국어 응답을 작성한다.
4. 향후 유사한 메시지를 자동 처리할 수 있는 JavaScript 정규식 패턴을 제안한다.
   - 패턴은 new RegExp(pattern, 'i') 형태로 검증 가능해야 한다.
   - 너무 포괄적이면 오탐 발생하므로 구체적으로 작성한다.
   - 명확한 패턴이 없으면 null.

반드시 JSON 한 블록만 출력 (다른 텍스트 없이):
{
  "user_response": "사용자에게 보낼 메시지 (한국어)",
  "intent": "인텐트명 또는 null",
  "args": {},
  "pattern": "정규식 문자열 또는 null",
  "reason": "판단 근거 한 줄"
}`;

  const result = await runClaudeAnalyzePrompt(prompt, {
    cwd: PROJECT_ROOT,
    timeout: 120000,
  });
  if (result.code !== 0) {
    return { ok: false, error: String(result.stderr || '').slice(0, 300) || `exit code ${result.code}` };
  }

  const output = String(result.stdout || '').trim();
  let parsed;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: true, message: output.slice(0, TG_MAX_CHARS) };
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { ok: true, message: output.slice(0, TG_MAX_CHARS) };
  }

  if (parsed.pattern && parsed.intent && parsed.intent !== 'unknown') {
    try {
      new RegExp(parsed.pattern);
      await saveLearning({
        re: parsed.pattern,
        intent: parsed.intent,
        args: parsed.args || {},
        original_text: text,
        reason: parsed.reason || '',
        confidence: 0.95,
      });
    } catch {
      console.warn(`[스카] 잘못된 정규식 패턴 무시: ${parsed.pattern}`);
    }
  }

  const userMsg = (parsed.user_response || output).slice(0, TG_MAX_CHARS);
  const patternAdded = (parsed.pattern && parsed.intent && parsed.intent !== 'unknown')
    ? `\n\n💡 패턴 학습: \`${parsed.pattern}\` → ${parsed.intent}` : '';

  return { ok: true, message: userMsg + patternAdded };
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  query_reservations: handleQueryReservations,
  query_today_stats:  handleQueryTodayStats,
  query_alerts:       handleQueryAlerts,
  restart_andy:       handleRestartAndy,
  restart_jimmy:      handleRestartJimmy,
  store_resolution:   handleStoreResolution,
  analyze_unknown:    handleAnalyzeUnknown,
};

async function processCommands() {
  try {
    const pending = await pgPool.query('claude', `
      SELECT * FROM bot_commands
      WHERE to_bot = $1 AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `, [BOT_ID]);

    for (const cmd of pending) {
      await pgPool.run('claude', `
        UPDATE bot_commands SET status = 'running' WHERE id = $1
      `, [cmd.id]);

      let result;
      try {
        const args = JSON.parse(cmd.args || '{}');
        const handler = HANDLERS[cmd.command];

        if (!handler) {
          result = { ok: false, error: `알 수 없는 명령: ${cmd.command}` };
        } else {
          result = await Promise.resolve(handler(args));
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      await pgPool.run('claude', `
        UPDATE bot_commands
        SET status = $1, result = $2, done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $3
      `, [result.ok ? 'done' : 'error', JSON.stringify(result), cmd.id]);

      console.log(`[스카] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[스카] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
const COMMAND_POLL_MS = 5000;
// 5초 루프 기준: 12 tick = 1분, 4320 tick = 6시간
let _identityCounter = 0;

async function main() {
  acquireLock();
  loadBotIdentity(); // 시작 시 정체성 로드
  await ensureIntentTables(pgPool, { schema: 'ska' });
  try { await rag.initSchema(); } catch { /* RAG 사용 불가 시 무시 */ }
  console.log(`🤖 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[스카] 루프 오류:`, e.message); }

    // 팀원 정체성 점검 + 자신의 정체성 리로드: 시작 1분 후 첫 실행, 이후 6시간마다
    _identityCounter++;
    if (_identityCounter % 4320 === 12) {
      try {
        loadBotIdentity(); // 정체성 리로드 (파일 변경 반영)
        console.log(`[스카] 역할 확인: ${BOT_IDENTITY.role}`);
        checkSkaTeamIdentity();
      } catch (e) { console.error(`[스카] 정체성 점검 오류:`, e.message); }
    }

    await new Promise(r => setTimeout(r, COMMAND_POLL_MS));
  }
}

main().catch(e => {
  console.error(`[스카] 치명적 오류:`, e);
  process.exit(1);
});
