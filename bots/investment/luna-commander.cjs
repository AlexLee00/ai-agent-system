#!/usr/bin/env node
'use strict';

/**
 * luna-commander.js — 루나 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: pause_trading, resume_trading, force_report, get_status
 *   - 일시정지: ~/.openclaw/workspace/luna-paused.flag 파일로 제어
 *     → crypto.js가 시작 시 이 파일 존재 여부로 스킵 판단
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync, spawnSync } = require('child_process');
const pgPool       = require('../../packages/core/lib/pg-pool');
const {
  AUTO_PROMOTE_DEFAULTS,
  normalizeIntentText,
  buildAutoLearnPattern,
  evaluateAutoPromoteDecision,
} = require('../../packages/core/lib/intent-core');
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
} = require('../../packages/core/lib/intent-store');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME       = '루나';
const BOT_ID         = 'luna';
const IDENTITY_FILE  = path.join(__dirname, 'context/COMMANDER_IDENTITY.md');
const PROJECT_ROOT   = path.join(os.homedir(), 'projects', 'ai-agent-system');
const NLP_LEARNINGS_PATH = getNamedIntentLearningPath('jay');
const TG_MAX_CHARS = 3500;

// ─── 정체성 로더 (LLM 없이 파일 기반) ──────────────────────────────
let BOT_IDENTITY = {
  name:    '루나 커맨더',
  team:    '루나팀',
  role:    '루나팀 팀장 — 암호화폐·주식 자동매매 지휘',
  mission: 'bot_commands 폴링(30초), 거래 정지·재개·리포트·상태 처리, 팀원 정체성 점검',
};

function loadBotIdentity() {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) {
      console.log(`[루나] 🎭 정체성: ${BOT_IDENTITY.role} (기본값)`);
      return;
    }
    const content = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const roleM    = content.match(/## 역할\n+([\s\S]*?)(?=\n## )/);
    const missionM = content.match(/## 임무\n+([\s\S]*?)(?=\n## )/);
    if (roleM)    BOT_IDENTITY.role    = roleM[1].trim().split('\n')[0];
    if (missionM) BOT_IDENTITY.mission = missionM[1].trim().replace(/^- /gm, '').split('\n')[0];
    console.log(`[루나] 🎭 정체성 로드: ${BOT_IDENTITY.role}`);
  } catch (e) {
    console.error(`[루나] 정체성 로드 실패:`, e.message);
  }
}

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH           = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-commander.lock');
const PAUSE_FLAG          = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-paused.flag');
const WITHDRAW_SCHED_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'withdraw-schedule.json');

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try { process.kill(Number(old), 0); console.error(`${BOT_NAME} 커맨더 이미 실행 중 (PID: ${old})`); process.exit(1); }
    catch { fs.unlinkSync(LOCK_PATH); }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── 메인봇 알람 발행 (mainbot_queue 직접 INSERT) ───────────────────

/**
 * 마스터에게 텔레그램 알람 발행
 * @param {string} message   - 발송할 메시지
 * @param {number} level     - 알람 레벨 (1=info, 2=warn, 3=error)
 */
async function publishAlert(message, level = 1) {
  try {
    await pgPool.run('claude', `
      INSERT INTO mainbot_queue (from_bot, event_type, alert_level, message, payload, status)
      VALUES ($1, 'system', $2, $3, '{}', 'pending')
    `, [BOT_ID, level, message]);
    console.log(`[루나] 마스터 알람 발행 (level ${level})`);
  } catch (e) {
    console.error(`[루나] 알람 발행 실패:`, e.message);
  }
}

async function saveLearning(entry) {
  try {
    const normalizedText = normalizeIntentText(entry.original_text || entry.re || '');
    const learnedPattern = entry.re || buildAutoLearnPattern(normalizedText);
    const intent = entry.intent;
    const confidence = Number(entry.confidence || 0.95);
    if (!normalizedText || !intent || !learnedPattern) return;

    await insertUnrecognizedIntent(pgPool, {
      schema: 'luna',
      text: entry.original_text || entry.re,
      parseSource: 'llm',
      llmIntent: intent,
    });

    const rows = await getRecentUnrecognizedIntents(pgPool, {
      schema: 'luna',
      windowDays: AUTO_PROMOTE_DEFAULTS.windowDays,
      limit: 500,
    });

    const matching = rows.filter(row =>
      normalizeIntentText(row.text) === normalizedText &&
      String(row.llm_intent || '') === String(intent)
    );

    await upsertPromotionCandidate(pgPool, {
      schema: 'luna',
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
      team: 'luna',
    });

    const candidate = await findPromotionCandidateIdByNormalized(pgPool, {
      schema: 'luna',
      normalizedText,
    });

    if (!decision.allowed) {
      await logPromotionEvent(pgPool, {
        schema: 'luna',
        candidateId: candidate?.id || null,
        normalizedText,
        sampleText: entry.original_text || entry.re,
        suggestedIntent: intent,
        eventType: decision.reason === 'unsafe_intent' ? 'auto_blocked' : 'candidate_seen',
        learnedPattern,
        actor: 'luna-commander',
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
      schema: 'luna',
      intent,
      text: entry.original_text || entry.re,
    });

    await upsertPromotionCandidate(pgPool, {
      schema: 'luna',
      normalizedText,
      sampleText: entry.original_text || entry.re,
      suggestedIntent: intent,
      occurrenceCount: matching.length,
      confidence,
      autoApplied: true,
      learnedPattern,
    });

    await logPromotionEvent(pgPool, {
      schema: 'luna',
      candidateId: candidate?.id || null,
      normalizedText,
      sampleText: entry.original_text || entry.re,
      suggestedIntent: intent,
      eventType: patternResult.changed ? 'auto_apply' : 'candidate_seen',
      learnedPattern,
      actor: 'luna-commander',
      metadata: {
        reason: entry.reason || '',
        source: 'analyze_unknown',
        threshold: decision.threshold,
        occurrenceCount: matching.length,
        confidence,
      },
    });

    if (patternResult.changed) {
      console.log(`[루나] NLP 패턴 학습: /${entry.re}/ → ${intent}`);
    }
  } catch (e) {
    console.error(`[루나] NLP 학습 저장 실패:`, e.message);
  }
}

// ─── 출금지연제 자동 예약 ────────────────────────────────────────────

/**
 * 출금 예약 저장 (withdraw-schedule.json)
 */
function saveWithdrawSchedule({ unlockAt, usdtBalance, network, address }) {
  const data = { unlockAt, usdtBalance, network, address, savedAt: new Date().toISOString() };
  fs.writeFileSync(WITHDRAW_SCHED_FILE, JSON.stringify(data, null, 2));
  console.log(`[루나] 출금 예약 저장: ${unlockAt}`);
}

/**
 * 예약된 출금 실행 여부 체크 (폴링 루프에서 호출)
 * unlockAt이 현재보다 과거면 즉시 출금 실행
 */
async function checkWithdrawSchedule() {
  if (!fs.existsSync(WITHDRAW_SCHED_FILE)) return;

  let sched;
  try {
    sched = JSON.parse(fs.readFileSync(WITHDRAW_SCHED_FILE, 'utf8'));
  } catch {
    fs.unlinkSync(WITHDRAW_SCHED_FILE);
    return;
  }

  const unlockAt = new Date(sched.unlockAt);
  const now      = new Date();

  if (now < unlockAt) {
    // 아직 해제 전 — 10분마다 로그
    const remainMin = Math.ceil((unlockAt - now) / 60000);
    if (remainMin % 10 === 0) {
      console.log(`[루나] 출금 대기 중: 약 ${remainMin}분 후 해제`);
    }
    return;
  }

  // 해제 시각 도래 → 예약 파일 삭제 후 출금 실행
  console.log(`[루나] 출금지연 해제 확인 → 자동 출금 시작`);
  fs.unlinkSync(WITHDRAW_SCHED_FILE);

  const result = await handleUpbitWithdrawOnly();
  if (result.ok) {
    await publishAlert(
      `✅ 루나 — 출금지연 해제 후 자동 출금 완료\n${result.message}`,
      1
    );
    console.log(`[루나] 자동 출금 완료`);
  } else if (result.delay) {
    // 아직 지연 중 (예상보다 늦게 해제됨) → 1시간 후 재예약
    const newUnlock = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    saveWithdrawSchedule({ ...sched, unlockAt: newUnlock });
    await publishAlert(
      `⏳ 루나 — 출금지연 미해제 (예상 시각 지났으나 아직 제한 중)\n1시간 후 재시도합니다.`,
      2
    );
  } else {
    await publishAlert(
      `❌ 루나 — 자동 출금 실패\n오류: ${result.error || '알 수 없음'}`,
      3
    );
  }
}

// ─── 팀원 정체성 점검·학습 ───────────────────────────────────────────

const BOT_ID_DIR   = path.join(os.homedir(), '.openclaw', 'workspace', 'bot-identities');
const TEAM_AGENTS  = path.join(__dirname, 'team');

const LUNA_TEAM = [
  { id: 'luna',        name: '루나',      llm: 'gpt-4o',  role: '최종 매수/매도 판단',               mission: '분석 종합 후 포지션 결정 및 헤파이스토스 지시' },
  { id: 'oracle',      name: '오라클',    llm: 'gpt-4o',  role: '온체인·파생 데이터 분석',           mission: '바이낸스 선물·온체인 지표 수집 및 시그널 생성' },
  { id: 'nemesis',     name: '네메시스',  llm: 'gpt-4o',  role: '리스크 평가',                       mission: 'APPROVE/ADJUST/REJECT 판정으로 과잉 진입 방지' },
  { id: 'athena',      name: '아테나',    llm: 'gpt-4o',  role: '매도 관점 근거·손절가 제시',        mission: '하방 리스크 논거 및 손절 기준 제공' },
  { id: 'zeus',        name: '제우스',    llm: 'gpt-4o',  role: '매수 관점 근거·목표가 제시',        mission: '상방 모멘텀 논거 및 목표가 제공' },
  { id: 'hermes',      name: '헤르메스',  llm: 'Groq',    role: '뉴스 수집·감성 분류',               mission: '암호화폐 뉴스 수집 및 긍정/부정 감성 점수화' },
  { id: 'sophia',      name: '소피아',    llm: 'Groq',    role: '커뮤니티 감성 분석',                mission: 'Reddit·Twitter 커뮤니티 감성 분석' },
  { id: 'argos',       name: '아르고스',  llm: 'Groq',    role: 'Reddit 전략 추천 수집',             mission: 'r/CryptoCurrency 등 전략 데이터 수집' },
  { id: 'hephaestos',  name: '헤파이스토스', llm: '—',   role: '자동화·주문 실행',                  mission: '루나 지시에 따라 바이낸스 API로 실제 주문 실행' },
  { id: 'hanul',       name: '한울',      llm: 'Groq',    role: '국내 주식 담당',                    mission: 'KIS API로 국내주식 신호 생성 및 주문 관리' },
];

function checkLunaTeamIdentity() {
  if (!fs.existsSync(BOT_ID_DIR)) fs.mkdirSync(BOT_ID_DIR, { recursive: true });

  const results = [];
  for (const member of LUNA_TEAM) {
    const issues  = [];
    let   trained = false;

    // 1. 에이전트 소스 파일 존재 여부
    const agentFile = path.join(TEAM_AGENTS, `${member.id}.js`);
    if (!fs.existsSync(agentFile)) issues.push(`에이전트 파일 없음: team/${member.id}.js`);

    // 2. 정체성 파일 체크
    const idFile = path.join(BOT_ID_DIR, `luna_${member.id}.json`);
    if (!fs.existsSync(idFile)) {
      fs.writeFileSync(idFile, JSON.stringify({
        name: member.name, team: '루나팀', role: member.role,
        mission: member.mission, llm: member.llm,
        updated_at: new Date().toISOString(),
      }, null, 2));
      trained = true;
      issues.push('→ 정체성 파일 생성');
    } else {
      const data  = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      const ageMs = Date.now() - new Date(data.updated_at || 0).getTime();
      const miss  = ['name', 'role', 'mission'].filter(f => !data[f]);
      if (miss.length > 0 || ageMs > 30 * 24 * 3600 * 1000) {
        if (miss.length > 0) issues.push(`누락 필드: ${miss.join(', ')}`);
        Object.assign(data, { name: member.name, team: '루나팀', role: member.role, mission: member.mission, llm: member.llm, updated_at: new Date().toISOString() });
        fs.writeFileSync(idFile, JSON.stringify(data, null, 2));
        trained = true;
        issues.push('→ 정체성 갱신');
      }
    }

    results.push({ name: member.name, issues, trained });
  }

  const problems = results.filter(r => r.issues.some(i => !i.startsWith('→')));
  if (problems.length > 0) {
    console.log(`[루나] 팀원 정체성 점검: ${problems.length}건 이슈`);
    for (const r of problems) console.log(`  ${r.name}: ${r.issues.filter(i => !i.startsWith('→')).join(' | ')}`);
  } else {
    console.log(`[루나] 팀원 정체성 점검: 정상`);
  }
  return results;
}

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 거래 일시정지 — luna-paused.flag 생성
 */
function handlePauseTrading(args) {
  try {
    const reason = args.reason || '제이 명령';
    fs.writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason }));
    return { ok: true, message: `거래 일시정지 설정 (이유: ${reason})\n다음 사이클부터 스킵됩니다.` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 거래 재개 — luna-paused.flag 삭제
 */
function handleResumeTrading() {
  try {
    if (!fs.existsSync(PAUSE_FLAG)) {
      return { ok: true, message: '이미 실행 중 상태입니다.' };
    }
    fs.unlinkSync(PAUSE_FLAG);
    return { ok: true, message: '거래 재개 완료. 다음 사이클(최대 5분)부터 정상 실행됩니다.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * execSync 실행 헬퍼 (manual/ 스크립트용)
 */
function runManualScript(relPath, cliArgs = []) {
  const nodeExe = process.execPath;
  const script  = path.join(__dirname, relPath);
  if (!fs.existsSync(script)) return { ok: false, error: `스크립트 없음: ${relPath}` };

  const argStr = cliArgs.join(' ');
  const stdout = execSync(`${nodeExe} ${script} ${argStr}`, {
    cwd:     __dirname,
    timeout: 60000,
    env:     { ...process.env },
  }).toString().trim();

  const jsonLine = stdout.split('\n').filter(l => l.startsWith('{')).pop();
  if (!jsonLine) return { ok: false, error: '스크립트 출력 없음', raw: stdout.slice(0, 200) };
  return JSON.parse(jsonLine);
}

/**
 * 업비트 전체 잔고 조회
 */
function handleGetUpbitBalance() {
  try {
    return runManualScript('manual/balance/upbit-balance.js');
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * 바이낸스 전체 잔고 조회
 */
function handleGetBinanceBalance() {
  try {
    return runManualScript('manual/balance/binance-balance.js');
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * 암호화폐 현재가 조회
 */
function handleGetCryptoPrice(args) {
  try {
    const cliArgs = args?.symbol ? [`--symbol=${args.symbol}`] : [];
    return runManualScript('manual/price/crypto-price.js', cliArgs);
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * KIS 국내주식 잔고 조회
 */
function handleGetKisDomesticBalance() {
  try {
    return runManualScript('manual/balance/kis-balance.js', ['--type=domestic']);
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * KIS 해외주식 잔고 조회
 */
function handleGetKisOverseasBalance() {
  try {
    return runManualScript('manual/balance/kis-balance.js', ['--type=overseas']);
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * 업비트 KRW→USDT 매수 후 바이낸스 전송
 * (실제 자금 이동 — secrets.json upbit_access_key / binance_deposit_address_usdt 필요)
 */
function handleUpbitToBinance() {
  try {
    const nodeExe = process.execPath;
    const script  = path.join(__dirname, 'manual', 'transfer', 'upbit-to-binance.js');
    if (!fs.existsSync(script)) return { ok: false, error: `스크립트 없음: manual/transfer/upbit-to-binance.js` };

    const stdout = execSync(`${nodeExe} ${script}`, {
      cwd:     __dirname,
      timeout: 120000,
      env:     { ...process.env },
    }).toString().trim();

    const jsonLine = stdout.split('\n').filter(l => l.startsWith('{')).pop();
    if (!jsonLine) return { ok: false, error: '스크립트 출력 없음', raw: stdout.slice(0, 200) };
    return JSON.parse(jsonLine);
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * 업비트 USDT 잔고 전량 바이낸스 출금 (KRW 매수 없이 출금만)
 * - 출금지연제 감지 시: 마스터에게 Telegram 안내 + 자동 예약
 */
async function handleUpbitWithdrawOnly() {
  try {
    const nodeExe = process.execPath;
    const script  = path.join(__dirname, 'manual', 'transfer', 'upbit-withdraw-only.js');
    if (!fs.existsSync(script)) return { ok: false, error: `스크립트 없음: manual/transfer/upbit-withdraw-only.js` };

    const stdout = execSync(`${nodeExe} ${script}`, {
      cwd:     __dirname,
      timeout: 60000,
      env:     { ...process.env },
    }).toString().trim();

    const jsonLine = stdout.split('\n').filter(l => l.startsWith('{')).pop();
    if (!jsonLine) return { ok: false, error: '스크립트 출력 없음', raw: stdout.slice(0, 200) };

    const result = JSON.parse(jsonLine);

    // ── 출금지연제 처리 ─────────────────────────────────────────────
    if (result.delay === true) {
      // 마스터에게 Telegram 안내 발송
      await publishAlert(result.message, 2);

      // 자동 출금 예약 저장
      if (result.unlockAt) {
        saveWithdrawSchedule({
          unlockAt:    result.unlockAt,
          usdtBalance: result.usdtBalance,
          network:     result.network,
          address:     result.address,
        });
      }

      console.log(`[루나] 출금지연제 감지 → 마스터 안내 + 자동 예약`);
    }

    return result;
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 400) || e.message };
  }
}

/**
 * 투자 리포트 강제 실행
 */
function handleForceReport() {
  try {
    const nodeExe  = process.execPath;
    const reportJs = path.join(__dirname, 'team', 'reporter.js');

    // reporter.js는 ESM — node --input-type=module 불필요 (파일 직접 실행)
    execSync(`${nodeExe} ${reportJs} --telegram`, {
      cwd:     __dirname,
      timeout: 120000,
      env:     { ...process.env },
    });
    return { ok: true, message: '투자 리포트 텔레그램 발송 완료' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 200) || e.message };
  }
}

/**
 * 루나팀 현재 상태 조회
 */
function handleGetStatus() {
  try {
    const stateFile = path.join(os.homedir(), '.openclaw', 'investment-state.json');
    if (!fs.existsSync(stateFile)) {
      return { ok: true, status: 'unknown', message: '상태 파일 없음' };
    }
    const state   = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const paused  = fs.existsSync(PAUSE_FLAG);
    const pauseInfo = paused ? JSON.parse(fs.readFileSync(PAUSE_FLAG, 'utf8')) : null;

    return {
      ok: true,
      paused,
      paused_at:   pauseInfo?.paused_at,
      pause_reason: pauseInfo?.reason,
      last_cycle:  state.lastCycleAt > 0
        ? new Date(state.lastCycleAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
        : '없음',
      balance_usdt: state.balance_usdt,
      mode:         state.mode || 'unknown',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

  const result = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    cwd: PROJECT_ROOT,
    timeout: 120000,
    env: { ...process.env },
    encoding: 'utf8',
  });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || '').slice(0, 300) };

  const output = (result.stdout || '').trim();
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
      console.warn(`[루나] 잘못된 정규식 패턴 무시: ${parsed.pattern}`);
    }
  }

  const userMsg = (parsed.user_response || output).slice(0, TG_MAX_CHARS);
  const patternAdded = (parsed.pattern && parsed.intent && parsed.intent !== 'unknown')
    ? `\n\n💡 패턴 학습: \`${parsed.pattern}\` → ${parsed.intent}` : '';

  return { ok: true, message: userMsg + patternAdded };
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  pause_trading:             handlePauseTrading,
  resume_trading:            handleResumeTrading,
  force_report:              handleForceReport,
  get_status:                handleGetStatus,
  upbit_to_binance:          handleUpbitToBinance,
  upbit_withdraw_only:       handleUpbitWithdrawOnly,
  get_upbit_balance:         handleGetUpbitBalance,
  get_binance_balance:       handleGetBinanceBalance,
  get_crypto_price:          handleGetCryptoPrice,
  get_kis_domestic_balance:  handleGetKisDomesticBalance,
  get_kis_overseas_balance:  handleGetKisOverseasBalance,
  analyze_unknown:           handleAnalyzeUnknown,
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
        const args    = JSON.parse(cmd.args || '{}');
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

      console.log(`[루나] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[루나] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
let _identityCounter = 0;

async function main() {
  acquireLock();
  loadBotIdentity(); // 시작 시 정체성 로드
  await ensureIntentTables(pgPool, { schema: 'luna' });
  console.log(`🌙 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[루나] 루프 오류:`, e.message); }

    // 출금지연 자동 예약 체크 (매 루프 = 30초마다)
    try { await checkWithdrawSchedule(); }
    catch (e) { console.error(`[루나] 출금 스케줄 체크 오류:`, e.message); }

    // 팀원 정체성 점검 + 자신의 정체성 리로드: 시작 1분 후 첫 실행, 이후 6시간마다
    _identityCounter++;
    if (_identityCounter % 720 === 2) {
      try {
        loadBotIdentity();
        console.log(`[루나] 역할 확인: ${BOT_IDENTITY.role}`);
        checkLunaTeamIdentity();
      } catch (e) { console.error(`[루나] 정체성 점검 오류:`, e.message); }
    }

    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(e => {
  console.error(`[루나] 치명적 오류:`, e);
  process.exit(1);
});
