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
const { execSync } = require('child_process');
const Database     = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME       = '루나';
const BOT_ID         = 'luna';
const IDENTITY_FILE  = path.join(__dirname, 'context/COMMANDER_IDENTITY.md');

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
const LOCK_PATH  = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-commander.lock');
const PAUSE_FLAG = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-paused.flag');

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

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  pause_trading:  handlePauseTrading,
  resume_trading: handleResumeTrading,
  force_report:   handleForceReport,
  get_status:     handleGetStatus,
};

async function processCommands() {
  try {
    const pending = getDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
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
  console.log(`🌙 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[루나] 루프 오류:`, e.message); }

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
