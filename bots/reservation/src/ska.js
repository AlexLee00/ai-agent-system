#!/usr/bin/env node
'use strict';

/**
 * src/ska.js — 스카 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: query_reservations, query_today_stats, query_alerts, restart_andy, restart_jimmy
 *   - 결과를 bot_commands.status='done', result=JSON으로 업데이트
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME       = '스카';
const BOT_ID         = 'ska';
const IDENTITY_FILE  = path.join(__dirname, '../context/COMMANDER_IDENTITY.md');

// ─── 정체성 로더 (LLM 없이 파일 기반) ──────────────────────────────
// 봇이 자신의 역할·임무를 인식하고 유지하기 위한 핵심 메커니즘.
// 향후 LLM 추가 시 BOT_IDENTITY를 시스템 프롬프트에 주입.

let BOT_IDENTITY = {
  name:    '스카 커맨더',
  team:    '스카팀',
  role:    '스카팀 팀장 — 스터디카페 운영 관리 지휘',
  mission: 'bot_commands 폴링(30초), 예약·매출·알람 조회, 앤디·지미 재시작, 팀원 정체성 점검',
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
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── DB ──────────────────────────────────────────────────────────────
const CMD_DB_PATH   = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
const STATE_DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'state.db');

let _cmdDb   = null;
let _stateDb = null;

function getCmdDb() {
  if (_cmdDb) return _cmdDb;
  _cmdDb = new Database(CMD_DB_PATH);
  _cmdDb.pragma('journal_mode = WAL');
  return _cmdDb;
}

function getStateDb() {
  if (_stateDb) return _stateDb;
  _stateDb = new Database(STATE_DB_PATH, { readonly: true });
  return _stateDb;
}

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

function checkSkaTeamIdentity() {
  if (!fs.existsSync(BOT_ID_DIR)) fs.mkdirSync(BOT_ID_DIR, { recursive: true });

  const results = [];
  for (const member of SKA_TEAM) {
    const issues  = [];
    let   trained = false;

    // 1. 프로세스 상태 (launchd 서비스 있는 봇만)
    if (member.launchd) {
      try {
        const out = execSync(`launchctl list ${member.launchd} 2>&1`, { encoding: 'utf8', timeout: 5000 });
        if (out.includes('Could not find')) issues.push('프로세스 미실행');
      } catch { issues.push('프로세스 상태 확인 실패'); }
    }

    // 2. 정체성 파일 체크 (없으면 생성, 30일 초과면 갱신)
    const idFile = path.join(BOT_ID_DIR, `${member.id}.json`);
    if (!fs.existsSync(idFile)) {
      fs.writeFileSync(idFile, JSON.stringify({
        name: member.name, team: member.team,
        role: member.role, mission: member.mission,
        launchd: member.launchd, updated_at: new Date().toISOString(),
      }, null, 2));
      trained = true;
      issues.push('→ 정체성 파일 생성');
    } else {
      const data    = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      const ageMs   = Date.now() - new Date(data.updated_at || 0).getTime();
      const missing = ['name', 'role', 'mission'].filter(f => !data[f]);
      if (missing.length > 0 || ageMs > 30 * 24 * 3600 * 1000) {
        if (missing.length > 0) issues.push(`누락 필드: ${missing.join(', ')}`);
        Object.assign(data, { name: member.name, team: member.team, role: member.role, mission: member.mission, updated_at: new Date().toISOString() });
        fs.writeFileSync(idFile, JSON.stringify(data, null, 2));
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

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 오늘 예약 현황 조회
 */
function handleQueryReservations(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  try {
    const rows = getStateDb().prepare(`
      SELECT name_enc, date, start_time, end_time, room, status
      FROM reservations
      WHERE date = ?
      ORDER BY start_time
    `).all(date);

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
function handleQueryTodayStats(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  try {
    const summary = getStateDb().prepare(`
      SELECT total_amount, entries_count FROM daily_summary WHERE date = ?
    `).get(date);

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
 * 미해결 알람 조회
 */
function handleQueryAlerts(args) {
  try {
    const limit = args.limit || 10;
    const rows = getStateDb().prepare(`
      SELECT type, title, message, timestamp
      FROM alerts
      WHERE resolved = 0
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return { ok: true, count: rows.length, alerts: rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 앤디 (네이버 모니터) 재시작
 */
function handleRestartAndy() {
  try {
    execSync(`launchctl kickstart -k gui/${process.getuid()} ai.ska.naver-monitor`, { timeout: 10000 });
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
    execSync(`launchctl kickstart -k gui/${process.getuid()} ai.ska.kiosk-monitor`, { timeout: 10000 });
    return { ok: true, message: '지미 재시작 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  query_reservations: handleQueryReservations,
  query_today_stats:  handleQueryTodayStats,
  query_alerts:       handleQueryAlerts,
  restart_andy:       handleRestartAndy,
  restart_jimmy:      handleRestartJimmy,
};

async function processCommands() {
  try {
    const pending = getCmdDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `).all(BOT_ID);

    for (const cmd of pending) {
      // running 상태로 전환
      getCmdDb().prepare(`
        UPDATE bot_commands SET status = 'running' WHERE id = ?
      `).run(cmd.id);

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

      // 완료 처리
      getCmdDb().prepare(`
        UPDATE bot_commands
        SET status = ?, result = ?, done_at = datetime('now')
        WHERE id = ?
      `).run(result.ok ? 'done' : 'error', JSON.stringify(result), cmd.id);

      console.log(`[스카] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[스카] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
// 30초 루프 기준: 2 tick = 1분, 720 tick = 6시간
let _identityCounter = 0;

async function main() {
  acquireLock();
  loadBotIdentity(); // 시작 시 정체성 로드
  console.log(`🤖 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[스카] 루프 오류:`, e.message); }

    // 팀원 정체성 점검 + 자신의 정체성 리로드: 시작 1분 후 첫 실행, 이후 6시간마다
    _identityCounter++;
    if (_identityCounter % 720 === 2) {
      try {
        loadBotIdentity(); // 정체성 리로드 (파일 변경 반영)
        console.log(`[스카] 역할 확인: ${BOT_IDENTITY.role}`);
        checkSkaTeamIdentity();
      } catch (e) { console.error(`[스카] 정체성 점검 오류:`, e.message); }
    }

    await new Promise(r => setTimeout(r, 30000)); // 30초 간격
  }
}

main().catch(e => {
  console.error(`[스카] 치명적 오류:`, e);
  process.exit(1);
});
