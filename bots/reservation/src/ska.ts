#!/usr/bin/env node
'use strict';

/**
 * src/ska.ts — 스카 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (5초 간격)
 *   - 명령 처리: query_reservations, register_reservation, cancel_reservation,
 *               query_today_stats, query_alerts, restart_andy, restart_jimmy
 *   - 결과를 bot_commands.status='done', result=JSON으로 업데이트
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag = require('../../../packages/core/lib/rag-safe');
const { safeWriteFile } = require('../../../packages/core/lib/file-guard');
const {
  ensureIntentTables,
  getNamedIntentLearningPath,
} = require('../../../packages/core/lib/intent-store');
const { initHubSecrets } = require('../lib/secrets');
const { checkSkaTeamIdentity } = require('../lib/ska-team');
const { createSkaCommandHandlers } = require('../lib/ska-command-handlers');
const { createSkaIntentLearning } = require('../lib/ska-intent-learning');
const { createSkaCommandQueue } = require('../lib/ska-command-queue');

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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[스카] 정체성 로드 실패:`, message);
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

const { handleAnalyzeUnknown } = createSkaIntentLearning({
  pgPool,
  learningPath: NLP_LEARNINGS_PATH,
  projectRoot: PROJECT_ROOT,
  tgMaxChars: TG_MAX_CHARS,
  team: 'ska',
  actor: 'ska-commander',
});

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  ...createSkaCommandHandlers({ pgPool, rag }),
  analyze_unknown:    handleAnalyzeUnknown,
};
const commandQueue = createSkaCommandQueue({
  pgPool,
  botId: BOT_ID,
  handlers: HANDLERS,
  schema: 'claude',
  limit: 5,
});

// ─── 메인 루프 ───────────────────────────────────────────────────────
const COMMAND_POLL_MS = 5000;
// 5초 루프 기준: 12 tick = 1분, 4320 tick = 6시간
let _identityCounter = 0;

async function main() {
  await initHubSecrets();
  acquireLock();
  loadBotIdentity(); // 시작 시 정체성 로드
  await ensureIntentTables(pgPool, { schema: 'ska' });
  try { await rag.initSchema(); } catch { /* RAG 사용 불가 시 무시 */ }
  console.log(`🤖 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);
  console.log(`   역할: ${BOT_IDENTITY.role}`);

  while (true) {
    try {
      const processed = await commandQueue.processPendingCommands();
      for (const row of processed) {
        console.log(`[스카] ${row.command} → ${row.ok ? 'done' : 'error'}`);
      }
    }
    catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[스카] 루프 오류:`, message);
    }

    // 팀원 정체성 점검 + 자신의 정체성 리로드: 시작 1분 후 첫 실행, 이후 6시간마다
    _identityCounter++;
    if (_identityCounter % 4320 === 12) {
      try {
        loadBotIdentity(); // 정체성 리로드 (파일 변경 반영)
        console.log(`[스카] 역할 확인: ${BOT_IDENTITY.role}`);
        checkSkaTeamIdentity();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[스카] 정체성 점검 오류:`, message);
      }
    }

    await new Promise(r => setTimeout(r, COMMAND_POLL_MS));
  }
}

main().catch((e: unknown) => {
  console.error(`[스카] 치명적 오류:`, e);
  process.exit(1);
});
