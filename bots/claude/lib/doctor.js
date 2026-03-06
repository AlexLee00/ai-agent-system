'use strict';

/**
 * lib/doctor.js — 독터 (자동 복구 봇)
 *
 * 역할: 덱스터가 감지한 문제를 실제로 수정/복구
 * 원칙: 화이트리스트에 있는 작업만 수행, 나머지는 거부
 *
 * 현재 경로: 덱스터 → 독터 (직접 지시)
 * 향후 경로: 덱스터 → 클로드(팀장) → 독터 (팀장 경유)
 *
 * 사용법:
 *   const doctor = require('./lib/doctor');
 *   const r = await doctor.execute('restart_launchd_service', { label: 'ai.ska.naver-monitor' }, 'dexter');
 *   console.log(r.success, r.message);
 */

const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');
const pgPool     = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';

// ─── 블랙리스트 (절대 금지 명령/패턴) ─────────────────────────────────────
const BLACKLIST = [
  'rm -rf',
  'DROP TABLE',
  'DELETE FROM',
  'DROP DATABASE',
  'git push --force',
  'git push -f',
  'chmod 777',
  'chmod 666',
  'kill -9',
  'npm audit fix --force',
  'secrets',
  'truncate',     // DB truncate 금지
  '--hard',       // git reset --hard 금지
];

/**
 * 블랙리스트 검사 — params를 JSON 직렬화한 문자열에 금지 패턴 포함 여부
 * @param {object} params
 * @returns {string|null} 위반 패턴 문자열, 없으면 null
 */
function _checkBlacklist(params) {
  const str = JSON.stringify(params || {}).toLowerCase();
  for (const banned of BLACKLIST) {
    if (str.includes(banned.toLowerCase())) return banned;
  }
  return null;
}

// ─── 화이트리스트 (허용된 복구 작업) ──────────────────────────────────────
const WHITELIST = {

  // ── 프로세스 복구 ──────────────────────────────────────────────────────
  restart_launchd_service: {
    description: 'launchd 서비스 재시작',
    requires_confirmation: false,
    allowed_services: [
      'ai.ska.naver-monitor',       // 앤디
      'ai.ska.kiosk-monitor',       // 지미
      'ai.claude.dexter.quick',     // 덱스터 퀵체크
      'ai.claude.dexter',           // 덱스터 full
      'ai.investment.crypto',       // 루나팀 크립토 사이클
      'ai.ska.commander',           // 스카 커맨더
      'ai.claude.commander',        // 클로드 커맨더
      'ai.investment.commander',    // 루나 커맨더
    ],
    action: async ({ label }) => {
      if (!label) throw new Error('label 파라미터 필수');
      const allowed = WHITELIST.restart_launchd_service.allowed_services;
      if (!allowed.includes(label)) {
        throw new Error(`허용되지 않은 서비스: ${label}. 허용 목록: ${allowed.join(', ')}`);
      }
      const uid = process.getuid ? process.getuid() : execSync('id -u', { encoding: 'utf8' }).trim();
      // kickstart -k: 이미 실행 중이면 강제 종료 후 재시작, -p: 출력 보존
      execSync(`launchctl kickstart -kp gui/${uid}/${label}`, { timeout: 15000, encoding: 'utf8' });
      return { restarted: label };
    },
  },

  // ── 파일 권한 수정 ──────────────────────────────────────────────────────
  fix_file_permissions: {
    description: '파일 권한 수정 (600)',
    requires_confirmation: false,
    allowed_filenames: ['secrets.json', 'config.yaml'],
    action: async ({ filePath }) => {
      if (!filePath) throw new Error('filePath 파라미터 필수');
      const basename = path.basename(filePath);
      const allowed  = WHITELIST.fix_file_permissions.allowed_filenames;
      if (!allowed.includes(basename)) {
        throw new Error(`허용되지 않은 파일: ${basename}. 허용 목록: ${allowed.join(', ')}`);
      }
      if (!fs.existsSync(filePath)) throw new Error(`파일 없음: ${filePath}`);
      const before = (fs.statSync(filePath).mode & 0o777).toString(8);
      execSync(`chmod 600 "${filePath}"`, { timeout: 5000 });
      return { filePath, before, after: '600' };
    },
  },

  // ── LLM 캐시 정리 ─────────────────────────────────────────────────────
  clear_expired_cache: {
    description: '만료된 LLM 캐시 정리',
    requires_confirmation: false,
    action: async () => {
      try {
        const cache   = require('../../../packages/core/lib/llm-cache');
        const deleted = await cache.cleanExpired();
        return { deleted };
      } catch (e) {
        throw new Error(`캐시 정리 실패: ${e.message}`);
      }
    },
  },

  // ── npm 보안 패치 ─────────────────────────────────────────────────────
  npm_audit_fix: {
    description: 'npm audit fix (--force 없이 안전 패치만)',
    requires_confirmation: true,  // 마스터 확인 필요
    action: async ({ cwd }) => {
      if (!cwd) throw new Error('cwd 파라미터 필수');
      // --force 절대 금지 — 안전 패치만
      const output = execSync('npm audit fix 2>&1', {
        cwd,
        timeout: 60000,
        encoding: 'utf8',
      });
      return { cwd, output: output.slice(0, 500) };
    },
  },
};

// ─── 복구 작업 실행 ────────────────────────────────────────────────────────

/**
 * 복구 작업 실행
 * @param {string} taskType     - WHITELIST 키
 * @param {object} params       - 작업 파라미터
 * @param {string} requestedBy  - 'dexter' | 'claude-lead'
 * @returns {Promise<{ success, message, data }>}
 */
async function execute(taskType, params = {}, requestedBy = 'dexter') {
  // 1. 블랙리스트 체크
  const banned = _checkBlacklist(params);
  if (banned) {
    const msg = `블랙리스트 위반 — "${banned}" 포함 파라미터 거부`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: msg };
  }

  // 2. 화이트리스트 확인
  const task = WHITELIST[taskType];
  if (!task) {
    const msg = `화이트리스트에 없는 작업: ${taskType}`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: msg };
  }

  // 3. 마스터 확인 필요 시 — 현재는 거부 후 알림으로 처리 (추후 텔레그램 연동 확장)
  if (task.requires_confirmation) {
    const msg = `"${task.description}" 작업은 마스터 확인이 필요합니다. 텔레그램으로 요청하세요.`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: msg, requiresConfirmation: true };
  }

  // 4. 실행
  try {
    const data = await task.action(params);
    await logRecovery(taskType, params, data, true, requestedBy, 'auto');
    const msg = `✅ [독터] ${task.description} 완료`;
    console.log(`${msg} — ${JSON.stringify(data)}`);
    return { success: true, message: msg, data };
  } catch (e) {
    await logRecovery(taskType, params, null, false, requestedBy, null, e.message);
    const msg = `❌ [독터] ${task.description} 실패: ${e.message}`;
    console.error(msg);
    return { success: false, message: msg };
  }
}

// ─── 복구 이력 기록 ────────────────────────────────────────────────────────

/**
 * @param {string}      taskType
 * @param {object}      params
 * @param {object|null} result
 * @param {boolean}     success
 * @param {string}      requestedBy
 * @param {string|null} confirmedBy
 * @param {string|null} errorMsg
 */
async function logRecovery(taskType, params, result, success, requestedBy, confirmedBy = null, errorMsg = null) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO doctor_log (task_type, params, result, success, error_msg, requested_by, confirmed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      taskType,
      JSON.stringify(params  ?? null),
      JSON.stringify(result  ?? null),
      success ? 1 : 0,
      errorMsg ?? null,
      requestedBy,
      confirmedBy ?? null,
    ]);
  } catch { /* DB 없으면 무시 */ }
}

// ─── 조회 함수 ─────────────────────────────────────────────────────────────

/**
 * 복구 가능 여부 확인 (덱스터가 호출)
 * @param {string} taskType
 * @returns {boolean}
 */
function canRecover(taskType) {
  return Object.prototype.hasOwnProperty.call(WHITELIST, taskType);
}

/**
 * 복구 이력 조회
 * @param {number} days  최근 N일
 * @returns {Array}
 */
async function getRecoveryHistory(days = 7) {
  try {
    return await pgPool.query(SCHEMA, `
      SELECT * FROM doctor_log
      WHERE executed_at > now() - ($1 || ' days')::INTERVAL
      ORDER BY executed_at DESC
      LIMIT 50
    `, [String(days)]);
  } catch { return []; }
}

/**
 * 사용 가능한 작업 목록 반환
 * @returns {Array<{ taskType, description, requiresConfirmation }>}
 */
function getAvailableTasks() {
  return Object.entries(WHITELIST).map(([taskType, task]) => ({
    taskType,
    description:          task.description,
    requiresConfirmation: task.requires_confirmation,
  }));
}

module.exports = {
  execute,
  canRecover,
  logRecovery,
  getRecoveryHistory,
  getAvailableTasks,
  WHITELIST,
  BLACKLIST,
};
