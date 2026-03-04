#!/usr/bin/env node
'use strict';

/**
 * src/claude-commander.js — 클로드팀 커맨더 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: run_check, run_full, run_fix, daily_report, run_archer
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync, spawnSync } = require('child_process');
const Database                = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME       = '클로드';
const BOT_ID         = 'claude';
const IDENTITY_FILE  = path.join(__dirname, '../context/COMMANDER_IDENTITY.md');

// ─── 정체성 로더 (LLM 없이 파일 기반) ──────────────────────────────
let BOT_IDENTITY = {
  name:    '클로드 커맨더',
  team:    '클로드팀',
  role:    '클로드팀 팀장 — 시스템 점검·기술 분석·AI 직접 소통 지휘',
  mission: 'bot_commands 폴링(30초), 덱스터·아처 실행, claude -p 직접 질문, NLP 자동 개선, 팀원 정체성 점검',
};

function loadBotIdentity() {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) {
      console.log(`[클로드] 🎭 정체성: ${BOT_IDENTITY.role} (기본값)`);
      return;
    }
    const content = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const roleM    = content.match(/## 역할\n+([\s\S]*?)(?=\n## )/);
    const missionM = content.match(/## 임무\n+([\s\S]*?)(?=\n## )/);
    if (roleM)    BOT_IDENTITY.role    = roleM[1].trim().split('\n')[0];
    if (missionM) BOT_IDENTITY.mission = missionM[1].trim().replace(/^- /gm, '').split('\n')[0];
    console.log(`[클로드] 🎭 정체성 로드: ${BOT_IDENTITY.role}`);
  } catch (e) {
    console.error(`[클로드] 정체성 로드 실패:`, e.message);
  }
}

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-commander.lock');

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

// ─── DB ──────────────────────────────────────────────────────────────
const CMD_DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
let _db = null;
function getDb() {
  if (_db) return _db;
  _db = new Database(CMD_DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ─── 명령 실행 헬퍼 ──────────────────────────────────────────────────
const NODE               = process.execPath;
const DEXTER             = path.join(__dirname, 'dexter.js');
const ARCHER             = path.join(__dirname, 'archer.js');
const CWD                = path.join(__dirname, '..');
const PROJECT_ROOT       = path.join(os.homedir(), 'projects', 'ai-agent-system');
const NLP_LEARNINGS_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'nlp-learnings.json');

// 텔레그램 메시지 최대 길이 (안전 마진 포함)
const TG_MAX_CHARS = 3500;

function runScript(script, flags = '') {
  execSync(`${NODE} ${script} ${flags}`, {
    cwd:     CWD,
    timeout: 300000, // 최대 5분
    env:     { ...process.env },
  });
}

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 덱스터 기본 점검
 */
function handleRunCheck() {
  try {
    runScript(DEXTER, '--telegram');
    return { ok: true, message: '덱스터 기본 점검 완료. 이상 시 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 전체 점검 (npm audit 포함)
 */
function handleRunFull() {
  try {
    runScript(DEXTER, '--full --telegram');
    return { ok: true, message: '덱스터 전체 점검 완료 (npm audit 포함).' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 자동 수정
 */
function handleRunFix() {
  try {
    runScript(DEXTER, '--fix --telegram');
    return { ok: true, message: '덱스터 자동 수정 완료. 결과 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 일일 보고
 */
function handleDailyReport() {
  try {
    runScript(DEXTER, '--daily-report --telegram');
    return { ok: true, message: '일일 보고 텔레그램 발송 완료.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 아처 기술 소화 실행
 */
function handleRunArcher() {
  try {
    runScript(ARCHER, '--telegram');
    return { ok: true, message: '아처 기술 소화 완료. 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 클로드 AI에게 직접 질문 (claude -p 헤드리스 모드)
 * 제이 → bot_commands → 클로드 AI → 응답 → 텔레그램
 */
function handleAskClaude(args) {
  const query = (args.query || '').trim();
  if (!query) return { ok: false, error: '질문 내용 없음' };

  const result = spawnSync('claude', ['-p', query, '--dangerously-skip-permissions'], {
    cwd:      PROJECT_ROOT,
    timeout:  280000, // 4분 40초 (커맨더 5분 내)
    env:      { ...process.env },
    encoding: 'utf8',
  });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const errMsg = (result.stderr || '').trim().slice(0, 300);
    return { ok: false, error: errMsg || `exit code ${result.status}` };
  }

  const response = (result.stdout || '').trim();
  if (!response) return { ok: false, error: '빈 응답' };

  // 텔레그램 길이 제한 처리
  const message = response.length > TG_MAX_CHARS
    ? response.slice(0, TG_MAX_CHARS) + '\n\n…(이하 생략)'
    : response;

  return { ok: true, message };
}

/**
 * NLP 학습 패턴 저장 (nlp-learnings.json)
 */
function saveLearning(entry) {
  try {
    let learnings = [];
    if (fs.existsSync(NLP_LEARNINGS_PATH)) {
      learnings = JSON.parse(fs.readFileSync(NLP_LEARNINGS_PATH, 'utf8'));
    }
    // 중복 패턴 방지
    if (!learnings.some(l => l.re === entry.re)) {
      learnings.push({ ...entry, added_at: new Date().toISOString() });
      fs.writeFileSync(NLP_LEARNINGS_PATH, JSON.stringify(learnings, null, 2));
      console.log(`[클로드] NLP 패턴 학습: /${entry.re}/ → ${entry.intent}`);
    }
  } catch (e) {
    console.error(`[클로드] NLP 학습 저장 실패:`, e.message);
  }
}

/**
 * 제이가 처리 못한 메시지 분석 및 NLP 자동 개선
 * 1) claude -p 로 의도 파악 + 사용자 응답 생성
 * 2) 제안된 패턴을 nlp-learnings.json에 저장
 * 3) intent-parser.js가 5분마다 리로드해서 자동 적용
 */
function handleAnalyzeUnknown(args) {
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
- claude_action command=run_full        : 덱스터 전체 점검 (npm audit)
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
    cwd:      PROJECT_ROOT,
    timeout:  120000, // 2분
    env:      { ...process.env },
    encoding: 'utf8',
  });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || '').slice(0, 300) };

  const output = (result.stdout || '').trim();

  // JSON 추출
  let parsed;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: true, message: output.slice(0, TG_MAX_CHARS) };
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { ok: true, message: output.slice(0, TG_MAX_CHARS) };
  }

  // 유효한 패턴 제안 → 저장 (intent-parser.js가 5분마다 리로드)
  if (parsed.pattern && parsed.intent && parsed.intent !== 'unknown') {
    try {
      new RegExp(parsed.pattern); // 유효성 검증
      saveLearning({
        re:            parsed.pattern,
        intent:        parsed.intent,
        args:          parsed.args || {},
        original_text: text,
        reason:        parsed.reason || '',
      });
    } catch {
      console.warn(`[클로드] 잘못된 정규식 패턴 무시: ${parsed.pattern}`);
    }
  }

  const userMsg = (parsed.user_response || output).slice(0, TG_MAX_CHARS);
  const patternAdded = (parsed.pattern && parsed.intent && parsed.intent !== 'unknown')
    ? `\n\n💡 패턴 학습: \`${parsed.pattern}\` → ${parsed.intent}` : '';

  return { ok: true, message: userMsg + patternAdded };
}

// ─── 팀원 정체성 점검·학습 ───────────────────────────────────────────

const CLAUDE_BOT_ID_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'bot-identities');

const CLAUDE_TEAM = [
  {
    id: 'dexter', name: '덱스터', launchd: 'ai.claude.dexter',
    role: '시스템 점검 (코드 무결성·보안·DB)',
    mission: '1시간마다 자동 점검, 이상 발견 시 Telegram 알람 발송',
    source: path.join(CWD, 'src/dexter.js'),
  },
  {
    id: 'archer', name: '아처', launchd: 'ai.claude.archer',
    role: '기술 인텔리전스 수집·분석',
    mission: '매주 월요일 09:00 KST 최신 AI·LLM 트렌드 수집 및 분석 보고',
    source: path.join(CWD, 'src/archer.js'),
  },
  {
    id: 'eric', name: '에릭', launchd: null,
    role: 'Explore 에이전트 (코드베이스 탐색·리서치)',
    mission: '수동 호출 시 코드베이스 분석 및 리서치 수행',
    source: null,
  },
  {
    id: 'kevin', name: '케빈', launchd: null,
    role: 'Plan 에이전트 (설계·구현 계획)',
    mission: '수동 호출 시 기능 설계 및 구현 계획 수립',
    source: null,
  },
  {
    id: 'brian', name: '브라이언', launchd: null,
    role: 'Bash 에이전트 (명령 실행·시스템 작업)',
    mission: '수동 호출 시 시스템 명령 실행 및 결과 보고',
    source: null,
  },
];

function checkClaudeTeamIdentity() {
  if (!fs.existsSync(CLAUDE_BOT_ID_DIR)) fs.mkdirSync(CLAUDE_BOT_ID_DIR, { recursive: true });

  const results = [];
  for (const member of CLAUDE_TEAM) {
    const issues  = [];
    let   trained = false;

    // 1. 프로세스 상태 (launchd 있는 봇만)
    if (member.launchd) {
      try {
        const out = require('child_process').execSync(
          `launchctl list ${member.launchd} 2>&1`, { encoding: 'utf8', timeout: 5000 }
        );
        if (out.includes('Could not find')) issues.push('프로세스 미실행');
      } catch { issues.push('프로세스 상태 확인 실패'); }
    }

    // 2. 소스 파일 존재 (있는 경우)
    if (member.source && !fs.existsSync(member.source)) {
      issues.push(`소스 파일 없음: ${path.basename(member.source)}`);
    }

    // 3. 정체성 파일 체크
    const idFile = path.join(CLAUDE_BOT_ID_DIR, `claude_${member.id}.json`);
    if (!fs.existsSync(idFile)) {
      fs.writeFileSync(idFile, JSON.stringify({
        name: member.name, team: '클로드팀', role: member.role,
        mission: member.mission, updated_at: new Date().toISOString(),
      }, null, 2));
      trained = true;
      issues.push('→ 정체성 파일 생성');
    } else {
      const data  = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      const ageMs = Date.now() - new Date(data.updated_at || 0).getTime();
      const miss  = ['name', 'role', 'mission'].filter(f => !data[f]);
      if (miss.length > 0 || ageMs > 30 * 24 * 3600 * 1000) {
        if (miss.length > 0) issues.push(`누락 필드: ${miss.join(', ')}`);
        Object.assign(data, { name: member.name, team: '클로드팀', role: member.role, mission: member.mission, updated_at: new Date().toISOString() });
        fs.writeFileSync(idFile, JSON.stringify(data, null, 2));
        trained = true;
        issues.push('→ 정체성 갱신');
      }
    }

    results.push({ name: member.name, issues, trained });
  }

  const problems = results.filter(r => r.issues.some(i => !i.startsWith('→')));
  if (problems.length > 0) {
    console.log(`[클로드] 팀원 정체성 점검: ${problems.length}건 이슈`);
    for (const r of problems) console.log(`  ${r.name}: ${r.issues.filter(i => !i.startsWith('→')).join(' | ')}`);
  } else {
    console.log(`[클로드] 팀원 정체성 점검: 정상`);
  }
  return results;
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  run_check:       handleRunCheck,
  run_full:        handleRunFull,
  run_fix:         handleRunFix,
  daily_report:    handleDailyReport,
  run_archer:      handleRunArcher,
  ask_claude:      handleAskClaude,
  analyze_unknown: handleAnalyzeUnknown,
};

async function processCommands() {
  try {
    const pending = getDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 3
    `).all(BOT_ID);

    for (const cmd of pending) {
      getDb().prepare(`
        UPDATE bot_commands SET status = 'running' WHERE id = ?
      `).run(cmd.id);

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

      getDb().prepare(`
        UPDATE bot_commands
        SET status = ?, result = ?, done_at = datetime('now')
        WHERE id = ?
      `).run(result.ok ? 'done' : 'error', JSON.stringify(result), cmd.id);

      console.log(`[클로드] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[클로드] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
let _identityCounter = 0;

async function main() {
  acquireLock();
  loadBotIdentity(); // 시작 시 정체성 로드
  console.log(`🤖 ${BOT_NAME} 팀 커맨더 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[클로드] 루프 오류:`, e.message); }

    // 팀원 정체성 점검 + 자신의 정체성 리로드: 시작 1분 후 첫 실행, 이후 6시간마다
    _identityCounter++;
    if (_identityCounter % 720 === 2) {
      try {
        loadBotIdentity();
        console.log(`[클로드] 역할 확인: ${BOT_IDENTITY.role}`);
        checkClaudeTeamIdentity();
      } catch (e) { console.error(`[클로드] 정체성 점검 오류:`, e.message); }
    }

    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(e => {
  console.error(`[클로드] 치명적 오류:`, e);
  process.exit(1);
});
