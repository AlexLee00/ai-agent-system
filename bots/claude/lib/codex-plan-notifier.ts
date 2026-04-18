// @ts-nocheck
'use strict';

/**
 * lib/codex-plan-notifier.ts — 코덱스 구현 계획 알림 브로드캐스터 ★
 *
 * 마스터가 요청한 핵심 기능:
 *   코덱스 자율 실행 시 구현 계획/진행/완료를 Telegram으로 자동 알림
 *
 * 동작 흐름:
 *   1. 5분 주기로 claude CLI 프로세스 감지
 *   2. 프롬프트에서 CODEX_*_EVOLUTION 패턴 + Phase 목록 파싱
 *   3. 시작/진행/완료/정체 이벤트 → Telegram 자동 발송
 *
 * Kill Switch: CLAUDE_CODEX_NOTIFIER_ENABLED=true (기본 false)
 * Shadow 모드: CLAUDE_NOTIFIER_SHADOW=true → 로그만 출력, 실제 발송 안 함
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const env = require('../../../packages/core/lib/env');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const ROOT       = env.PROJECT_ROOT;
const WORKSPACE  = path.join(os.homedir(), '.openclaw', 'workspace');
const STATE_FILE = path.join(WORKSPACE, 'codex-notifier-state.json');

const CHECK_INTERVAL_MS   = 5 * 60 * 1000;   // 5분
const STALL_THRESHOLD_MS  = 30 * 60 * 1000;  // 30분 정체 시 경고
const DEDUPE_WINDOW_MS    = 60_000;           // 1분 내 중복 차단
const RATE_LIMIT_PER_HOUR = 20;              // 시간당 최대 20건

// ─── 타입 정의 ────────────────────────────────────────────────────────

/**
 * @typedef {Object} Phase
 * @property {string} id         - "A" | "N" | "D" | "C" | "T" 등
 * @property {string} name       - Phase 설명 텍스트
 * @property {string} estimated  - "2~3일" 등
 * @property {string[]} files    - 예상 파일 목록
 * @property {string[]} killSwitches - Kill Switch 목록
 * @property {string} rollbackTag   - git tag 이름
 */

/**
 * @typedef {Object} CodexExecution
 * @property {number}   pid
 * @property {Date}     started_at
 * @property {string}   prompt_file
 * @property {Phase[]}  total_phases
 * @property {Phase|null} current_phase
 * @property {Phase[]}  completed_phases
 * @property {string}   last_commit_sha
 * @property {number}   last_commit_at    - timestamp ms
 * @property {{tests: number, failures: number}} last_test_status
 * @property {string}   status            - 'running'|'completed'|'failed'|'stalled'
 * @property {number}   last_alert_at
 * @property {string}   last_alert_type
 */

// ─── 유틸리티 ─────────────────────────────────────────────────────────

function safeExec(command, options = {}) {
  try {
    return execSync(command, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
      ...options,
    }).trim();
  } catch {
    return '';
  }
}

function timeSince(ts) {
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs / 24)}일 전`;
}

function durationSince(ts) {
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}분`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 ${mins % 60}분`;
  return `${Math.floor(hrs / 24)}일 ${hrs % 24}시간`;
}

function hashMessage(msg) {
  return crypto.createHash('md5').update(msg).digest('hex').slice(0, 12);
}

// ─── 상태 관리 ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[codex-notifier] 상태 저장 실패:', e.message);
  }
}

function loadCurrentState() {
  return loadState();
}

// ─── 프로세스 감지 ────────────────────────────────────────────────────

function getProcStartTime(pid) {
  try {
    const out = safeExec(`ps -p ${pid} -o lstart= 2>/dev/null`);
    if (out) return new Date(out);
  } catch {}
  return new Date();
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getCurrentCommit() {
  return safeExec('git rev-parse --short HEAD', { cwd: ROOT }) || 'unknown';
}

function getLastCommitTime() {
  try {
    const ts = safeExec('git log -1 --format=%ct', { cwd: ROOT });
    return ts ? Number(ts) * 1000 : Date.now();
  } catch {
    return Date.now();
  }
}

// ─── Phase 파싱 ───────────────────────────────────────────────────────

function extractExpectedFiles(content, phaseId) {
  const files = [];
  // ## 📋 Phase X ... ~ ## 📋 Phase Y 사이 내용에서 파일명 패턴 추출
  const phaseBlockRegex = new RegExp(
    `##\\s+📋\\s+Phase\\s+${phaseId}[\\s\\S]*?(?=##\\s+📋\\s+Phase\\s+[A-Z]|$)`,
    'g'
  );
  const block = (phaseBlockRegex.exec(content) || [])[0] || '';

  const filePatterns = [
    /`([a-zA-Z0-9/_.\-]+\.(ts|js|ex|exs|sql|json|plist|yaml))`/g,
    /\/\/\s+([a-zA-Z0-9/_.\-]+\.(ts|js|ex|exs|sql))\s/g,
  ];

  for (const pattern of filePatterns) {
    let m;
    while ((m = pattern.exec(block)) !== null) {
      const f = m[1];
      if (f && !files.includes(f) && !f.startsWith('//')) {
        files.push(f);
      }
    }
  }

  return files.slice(0, 8);
}

function extractKillSwitches(content, phaseId) {
  const switches = [];
  const regex = /CLAUDE_[A-Z_]+(?:_ENABLED)?/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    if (!switches.includes(m[0])) switches.push(m[0]);
  }
  return switches.slice(0, 5);
}

/**
 * 프롬프트 내용에서 Phase 목록 파싱
 */
function parsePhases(content) {
  const phases = [];
  // ## 📋 Phase X (설명 — 기간) 또는 ## 📋 Phase X (설명) — 기간
  const phaseRegex = /##\s+📋\s+Phase\s+([A-Z0-9]+)\s+\(([^)]+)\)(?:\s+—\s+(\S+(?:\s+\S+)?))?/g;
  let m;

  while ((m = phaseRegex.exec(content)) !== null) {
    const id        = m[1];
    const name      = m[2];
    const estimated = m[3] || '미정';

    phases.push({
      id,
      name,
      estimated,
      files: extractExpectedFiles(content, id),
      killSwitches: extractKillSwitches(content, id),
      rollbackTag: `pre-phase-${id.toLowerCase()}-claude-evolution`,
    });
  }

  return phases;
}

/**
 * ps aux 로 claude 프로세스 감지
 */
async function detectCodexProcesses() {
  const executions = [];

  try {
    // claude --print 또는 claude CLI 실행 감지
    const ps = safeExec(
      "ps aux | grep -E 'claude.*CODEX|claude.*codex|claude.*--print' | grep -v grep | grep -v 'codex-notifier'",
    );
    if (!ps) return executions;

    for (const line of ps.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[1]);
      if (!pid || !isProcessAlive(pid)) continue;

      const cmdLine = parts.slice(10).join(' ');

      // 프롬프트 파일 경로 추출
      const fileMatch = cmdLine.match(/CODEX_([A-Z_]+?)(?:\.md|_EVOLUTION|_REMODEL|_COMPLETE)/i);
      const promptName = fileMatch ? `CODEX_${fileMatch[1]}_EVOLUTION` : 'CODEX_CLAUDE_EVOLUTION';
      const promptFile = `docs/codex/${promptName}.md`;

      // 프롬프트 파일 내용 읽기
      let promptContent = '';
      const promptPath = path.join(ROOT, promptFile);
      if (fs.existsSync(promptPath)) {
        try { promptContent = fs.readFileSync(promptPath, 'utf8'); } catch {}
      }

      executions.push({
        pid,
        started_at: getProcStartTime(pid).getTime(),
        prompt_file: promptFile,
        total_phases: parsePhases(promptContent),
        current_phase: null,
        completed_phases: [],
        last_commit_sha: getCurrentCommit(),
        last_commit_at: getLastCommitTime(),
        last_test_status: { tests: 0, failures: 0 },
        status: 'running',
        last_alert_at: 0,
        last_alert_type: '',
      });
    }
  } catch (e) {
    console.warn('[codex-notifier] 프로세스 감지 오류:', e.message);
  }

  return executions;
}

// ─── Phase 전환 감지 ──────────────────────────────────────────────────

function detectPhaseTransition(prevState, currentCommit) {
  // git tag로 Phase 전환 감지
  try {
    const tags = safeExec('git tag --sort=-creatordate | head -5', { cwd: ROOT });
    const phaseTagMatch = tags.match(/pre-phase-([a-z0-9]+)-[a-z]+-evolution/i);
    if (phaseTagMatch) {
      const phaseId = phaseTagMatch[1].toUpperCase();
      if (!prevState.detected_tags?.includes(phaseTagMatch[0])) {
        return phaseId;
      }
    }
  } catch {}
  return null;
}

function detectPhaseCompletion(prevState, exec) {
  // git log 에서 "Phase X 완료" 패턴 커밋 감지
  try {
    const log = safeExec('git log --oneline -5', { cwd: ROOT });
    const completionMatch = log.match(/feat\([^)]+\):\s*Phase\s+([A-Z])\s+완료/);
    if (completionMatch) {
      const phaseId = completionMatch[1];
      const alreadyDone = (exec.completed_phases || []).some(p => p.id === phaseId);
      if (!alreadyDone) {
        const phase = (exec.total_phases || []).find(p => p.id === phaseId);
        return phase || { id: phaseId, name: `Phase ${phaseId}`, estimated: '', files: [], killSwitches: [], rollbackTag: '' };
      }
    }
  } catch {}
  return null;
}

// ─── 알림 포맷 ────────────────────────────────────────────────────────

function formatPlanStartMessage(exec, phase) {
  const lines = [
    `📋 코덱스 Phase ${phase.id} 시작`,
    '',
    `🎯 ${phase.name}`,
    `⏰ 예상 소요: ${phase.estimated}`,
    `🧬 프롬프트: ${exec.prompt_file}`,
  ];

  if (phase.files && phase.files.length > 0) {
    lines.push('');
    lines.push('📁 예상 변경 파일:');
    phase.files.slice(0, 5).forEach(f => lines.push(`  • ${f}`));
  }

  if (phase.killSwitches && phase.killSwitches.length > 0) {
    lines.push('');
    lines.push('🔐 Kill Switch:');
    phase.killSwitches.slice(0, 3).forEach(k => lines.push(`  • ${k} (기본 OFF)`));
  }

  lines.push('');
  lines.push(`🔄 롤백 포인트: ${phase.rollbackTag}`);
  lines.push(`PID: ${exec.pid}`);

  return lines.join('\n');
}

function formatProgressMessage(exec) {
  const current   = exec.current_phase;
  const done      = (exec.completed_phases || []).length;
  const total     = (exec.total_phases || []).length;
  const pct       = total > 0 ? Math.round((done / total) * 100) : 0;
  const testInfo  = exec.last_test_status;

  const lines = [
    `⏳ 코덱스 진행 중 (${pct}%)`,
    '',
    `📊 ${current?.name || '진행 중'}`,
    `✅ 완료: ${done}/${total} Phase`,
    '',
    `최신 커밋: ${exec.last_commit_sha || 'N/A'}`,
    `최신 커밋: ${timeSince(exec.last_commit_at)}`,
  ];

  if (testInfo && testInfo.tests > 0) {
    lines.push(`📊 테스트: ${testInfo.tests}개, ${testInfo.failures} failures`);
  }

  lines.push(`PID: ${exec.pid} (${exec.status})`);

  return lines.join('\n');
}

function formatCompletionMessage(exec, phase) {
  const testInfo = exec.last_test_status;
  const lines = [
    `✅ 코덱스 Phase ${phase.id} 완료`,
    '',
    `🎯 ${phase.name}`,
    `⏰ 소요: ${durationSince(exec.started_at)}`,
  ];

  if (testInfo && testInfo.tests > 0) {
    lines.push('');
    lines.push('📊 최종 상태:');
    lines.push(`  테스트: ${testInfo.tests}개, ${testInfo.failures} failures`);
  }

  lines.push(`  최근 커밋: ${exec.last_commit_sha?.slice(0, 8) || 'N/A'}`);

  const allPhases = exec.total_phases || [];
  const completedIds = [...(exec.completed_phases || []).map(p => p.id), phase.id];
  const nextPhase = allPhases.find(p => !completedIds.includes(p.id));
  if (nextPhase) {
    lines.push('');
    lines.push(`🔄 다음 Phase: ${nextPhase.id} — ${nextPhase.name}`);
  } else {
    lines.push('');
    lines.push('🏁 전체 완료!');
  }

  return lines.join('\n');
}

function formatStallMessage(exec, stallMinutes) {
  const lines = [
    `⚠️ 코덱스 정체 감지`,
    '',
    `🎯 ${exec.current_phase?.name || '진행 중'}`,
    `⏰ 마지막 커밋: ${stallMinutes}분 전`,
    '',
    `✅ 프로세스 살아있음: ${isProcessAlive(exec.pid) ? 'YES' : 'NO'}`,
    '',
    '📋 조치 필요:',
    '  - 로그 확인',
    '  - 에러 체크',
    '  - 필요 시 수동 개입',
  ];
  return lines.join('\n');
}

// ─── Telegram 발송 (Rate Limit + Dedup) ──────────────────────────────

const _notifierStateCache = {};
let _notifierStateCacheTs = 0;

function loadNotifierState() {
  const now = Date.now();
  if (now - _notifierStateCacheTs < 5000) return _notifierStateCache;
  const stateFile = path.join(WORKSPACE, 'codex-notifier-meta.json');
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      Object.assign(_notifierStateCache, data);
    }
  } catch {}
  _notifierStateCacheTs = now;
  return _notifierStateCache;
}

function saveNotifierState(state) {
  const stateFile = path.join(WORKSPACE, 'codex-notifier-meta.json');
  try {
    if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {}
}

async function sendTelegram(msg) {
  const shadowMode = process.env.CLAUDE_NOTIFIER_SHADOW !== 'false';
  const msgHash = hashMessage(msg);
  const state = loadNotifierState();

  if (!state.recent_messages) state.recent_messages = {};

  // 1. Dedup (1분 내 중복 차단)
  const lastSent = state.recent_messages[msgHash];
  if (lastSent && Date.now() - lastSent < DEDUPE_WINDOW_MS) {
    console.log('[codex-notifier] 중복 알림 차단:', msgHash);
    return false;
  }

  // 2. Rate limit (시간당 20건)
  const hourAgo = Date.now() - 3600_000;
  const recentCount = Object.values(state.recent_messages).filter(ts => ts > hourAgo).length;
  if (recentCount >= RATE_LIMIT_PER_HOUR) {
    console.log(`[codex-notifier] Rate limit (${recentCount}/hour)`);
    return false;
  }

  // 3. Shadow 모드 — 로그만 출력
  if (shadowMode) {
    console.log('[codex-notifier] [SHADOW] 발송 예정 메시지:');
    console.log(msg);
    console.log('─'.repeat(40));
    state.recent_messages[msgHash] = Date.now();
    saveNotifierState(state);
    return true;
  }

  // 4. 실제 발송
  try {
    await postAlarm({ message: msg, team: 'claude', alertLevel: 2, fromBot: 'codex-notifier' });
    console.log('[codex-notifier] 알림 발송 완료');
    state.recent_messages[msgHash] = Date.now();
    saveNotifierState(state);
    return true;
  } catch (e) {
    console.warn('[codex-notifier] 발송 실패:', e.message);
    return false;
  }
}

// ─── 메인 루프 ────────────────────────────────────────────────────────

async function mainLoop() {
  console.log('[codex-notifier] 시작 — 5분 주기 감시 (Shadow 모드)');

  while (true) {
    try {
      const currentState = loadState();
      const activeExecs  = await detectCodexProcesses();

      // 현재 시점 git 정보
      const currentCommit   = getCurrentCommit();
      const currentCommitAt = getLastCommitTime();

      for (const exec of activeExecs) {
        const prevState = currentState[exec.pid];

        // 상태 업데이트
        exec.last_commit_sha = currentCommit;
        exec.last_commit_at  = currentCommitAt;

        if (!prevState) {
          // 새 코덱스 프로세스 발견
          const firstPhase = exec.total_phases?.[0];
          if (firstPhase) {
            await sendTelegram(formatPlanStartMessage(exec, firstPhase));
            exec.current_phase    = firstPhase;
            exec.last_alert_type  = 'plan_start';
            exec.last_alert_at    = Date.now();
          }
          currentState[exec.pid] = exec;
          continue;
        }

        // 기존 상태 유지 + 업데이트
        prevState.last_commit_sha = currentCommit;
        prevState.last_commit_at  = currentCommitAt;

        // Phase 완료 감지
        const completedPhase = detectPhaseCompletion(prevState, prevState);
        if (completedPhase) {
          await sendTelegram(formatCompletionMessage(prevState, completedPhase));
          if (!prevState.completed_phases) prevState.completed_phases = [];
          prevState.completed_phases.push(completedPhase);
          prevState.last_alert_type = 'phase_complete';
          prevState.last_alert_at   = Date.now();
        }

        // 정체 감지 (30분 이상 커밋 없음)
        const stallMinutes = (Date.now() - prevState.last_commit_at) / 60000;
        if (stallMinutes > 30 && prevState.last_alert_type !== 'stall') {
          await sendTelegram(formatStallMessage(prevState, Math.floor(stallMinutes)));
          prevState.last_alert_type = 'stall';
          prevState.last_alert_at   = Date.now();
        } else if (stallMinutes < 5 && prevState.last_alert_type === 'stall') {
          prevState.last_alert_type = 'running';
        }

        currentState[exec.pid] = prevState;
      }

      // 종료된 프로세스 처리
      for (const pidStr of Object.keys(currentState)) {
        const pid = Number(pidStr);
        if (!activeExecs.find(e => e.pid === pid) && !isProcessAlive(pid)) {
          const staleExec = currentState[pidStr];
          const done  = (staleExec.completed_phases || []).length;
          const total = (staleExec.total_phases || []).length;
          await sendTelegram(
            `🏁 코덱스 프로세스 종료\nPID: ${pidStr}\n완료 Phase: ${done}/${total}\n소요: ${durationSince(staleExec.started_at)}`
          );
          delete currentState[pidStr];
        }
      }

      saveState(currentState);
    } catch (e) {
      console.error('[codex-notifier] 루프 오류:', e.message);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

// ─── 수동 테스트 ──────────────────────────────────────────────────────

async function runManualTest(testMessage = '수동 테스트 알림') {
  const msg = `📋 [코덱스 알림 테스트]\n${testMessage}\n시간: ${new Date().toLocaleString('ko-KR')}`;
  const sent = await sendTelegram(msg);
  return { message: sent ? '✅ 테스트 알림 발송 완료 (Shadow 모드 확인)' : '⚠️ 발송 실패 또는 Rate Limit', sent };
}

module.exports = {
  mainLoop,
  detectCodexProcesses,
  parsePhases,
  formatPlanStartMessage,
  formatProgressMessage,
  formatCompletionMessage,
  formatStallMessage,
  sendTelegram,
  runManualTest,
  loadCurrentState,
  isProcessAlive,
};
