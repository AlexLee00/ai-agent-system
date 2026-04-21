// @ts-nocheck
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
const { execSync, execFileSync } = require('child_process');
const pgPool     = require('../../../packages/core/lib/pg-pool');
const eventLake  = require('../../../packages/core/lib/event-lake');
const { publishToRag, publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const SCHEMA      = 'reservation';
const ROOT        = path.join(__dirname, '../../../');
const LAUNCHD_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const doctorMemory = createAgentMemory({ agentId: 'claude.doctor', team: 'claude' });
const RECOVERY_BLACKLIST = new Set([
  'ai.ops.platform.backend',
  'ai.ops.platform.frontend',
  'ai.orchestrator',
]);
const RESTART_TIMEOUT_COOLDOWN_MINUTES = 15;
const RESTART_TIMEOUT_COOLDOWN_FAILS = 3;

function kickstartLaunchdService(uid, label, timeout = 15000) {
  return execFileSync(
    'launchctl',
    ['kickstart', '-kp', `gui/${uid}/${label}`],
    { timeout, encoding: 'utf8' },
  );
}

async function isRestartCooldownActive(label) {
  if (!label) return false;
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT COUNT(*)::int AS cnt
      FROM doctor_log
      WHERE task_type = 'restart_launchd_service'
        AND success <> 1
        AND error_msg ILIKE '%ETIMEDOUT%'
        AND params::jsonb->>'label' = $1
        AND executed_at::timestamp > now() - ($2::text || ' minutes')::INTERVAL
    `, [label, String(RESTART_TIMEOUT_COOLDOWN_MINUTES)]);
    const cnt = Number(rows?.[0]?.cnt || 0);
    return cnt >= RESTART_TIMEOUT_COOLDOWN_FAILS;
  } catch (e) {
    console.warn('[doctor] restart cooldown 조회 실패 (무시):', e.message);
    return false;
  }
}

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
 * @typedef {Object} RecoveryResult
 * @property {boolean} success
 * @property {string} message
 * @property {any} [data]
 * @property {boolean} [requiresConfirmation]
 */

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
    action: async ({ label }) => {
      if (!label) throw new Error('label 파라미터 필수');
      if (!String(label).startsWith('ai.')) throw new Error(`ai.* 서비스만 허용: ${label}`);
      if (RECOVERY_BLACKLIST.has(label)) throw new Error(`블랙리스트 서비스: ${label}`);
      const uid = process.getuid ? process.getuid() : execSync('id -u', { encoding: 'utf8' }).trim();
      // kickstart -k: 이미 실행 중이면 강제 종료 후 재시작, -p: 출력 보존
      kickstartLaunchdService(uid, label, 15000);
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
 * @returns {Promise<RecoveryResult>}
 */
async function execute(taskType, params = {}, requestedBy = 'dexter') {
  const recentRecoveryHint = await doctorMemory.recallCountHint(
    [String(taskType || ''), String(requestedBy || ''), String(params?.label || '')].filter(Boolean).join(' '),
    {
      type: 'episodic',
      limit: 2,
      threshold: 0.35,
      title: '최근 유사 복구',
      separator: 'pipe',
      metadataKey: 'success',
      labels: {
        true: '성공',
        false: '실패',
      },
      order: ['true', 'false'],
      caution: {
        key: 'false',
        minCount: 2,
        moreThanKey: 'true',
        message: '주의: 최근 유사 복구에서 실패 비중이 높습니다. 수동 점검을 우선 고려하세요.',
      },
    },
  ).catch(() => '');
  const semanticRecoveryHint = await doctorMemory.recallHint(
    [String(taskType || ''), String(params?.label || ''), 'consolidated recovery pattern'].filter(Boolean).join(' '),
    {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    },
  ).catch(() => '');
  const memoryHints = `${recentRecoveryHint}${semanticRecoveryHint}`;

  // 1. 블랙리스트 체크
  const banned = _checkBlacklist(params);
  if (banned) {
    const msg = `블랙리스트 위반 — "${banned}" 포함 파라미터 거부`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: `${msg}${memoryHints}` };
  }

  // 2. 화이트리스트 확인
  const task = WHITELIST[taskType];
  if (!task) {
    const msg = `화이트리스트에 없는 작업: ${taskType}`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: `${msg}${memoryHints}` };
  }

  // 3. 마스터 확인 필요 시 — 현재는 거부 후 알림으로 처리 (추후 텔레그램 연동 확장)
  if (task.requires_confirmation) {
    const msg = `"${task.description}" 작업은 마스터 확인이 필요합니다. 텔레그램으로 요청하세요.`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: `${msg}${memoryHints}`, requiresConfirmation: true };
  }

  if (taskType === 'restart_launchd_service' && await isRestartCooldownActive(params?.label)) {
    const msg = `최근 launchctl timeout이 반복되어 재시작을 잠시 보류합니다: ${params?.label}`;
    await logRecovery(taskType, params, null, false, requestedBy, null, msg);
    return { success: false, message: `${msg}${memoryHints}` };
  }

  // 4. 실행
  try {
    const data = await task.action(params);
    await logRecovery(taskType, params, data, true, requestedBy, 'auto');
    const msg = `✅ [독터] ${task.description} 완료`;
    console.log(`${msg} — ${JSON.stringify(data)}`);
    return { success: true, message: `${msg}${memoryHints}`, data };
  } catch (e) {
    await logRecovery(taskType, params, null, false, requestedBy, null, e.message);
    const msg = `❌ [독터] ${task.description} 실패: ${e.message}`;
    console.error(msg);
    return { success: false, message: `${msg}${memoryHints}` };
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
  } catch (e) { console.warn('[doctor] doctor_log INSERT 실패 (메인 로직에 영향 없음):', e.message); }

  try {
    const summaryParts = [
      success ? `복구 성공: ${taskType}` : `복구 실패: ${taskType}`,
      requestedBy ? `요청자: ${requestedBy}` : '',
      confirmedBy ? `승인: ${confirmedBy}` : '',
      errorMsg ? `오류: ${errorMsg}` : '',
    ].filter(Boolean);
    const detailParts = [
      params && Object.keys(params).length > 0 ? `params=${JSON.stringify(params)}` : '',
      result && Object.keys(result).length > 0 ? `result=${JSON.stringify(result)}` : '',
    ].filter(Boolean);

    await doctorMemory.remember([...summaryParts, ...detailParts].join(' | '), 'episodic', {
      keywords: [
        'doctor',
        success ? 'recovery-success' : 'recovery-failure',
        String(taskType || ''),
        String(requestedBy || ''),
      ].filter(Boolean).slice(0, 8),
      importance: success ? 0.68 : 0.82,
      expiresIn: 30 * 24 * 60 * 60,
      metadata: {
        type: 'doctor_recovery_log',
        taskType,
        success: !!success,
        requestedBy: requestedBy || null,
        confirmedBy: confirmedBy || null,
        errorMsg: errorMsg || null,
        params: params || null,
      },
    });
  } catch (e) {
    console.warn('[doctor] agent memory 저장 실패 (메인 로직에 영향 없음):', e.message);
  }

  try {
    await doctorMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
      sourceType: 'episodic',
      targetType: 'semantic',
    });
  } catch (e) {
    console.warn('[doctor] agent memory 통합 실패 (메인 로직에 영향 없음):', e.message);
  }
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
 * @returns {Promise<any[]>}
 */
async function getRecoveryHistory(days = 7) {
  try {
    return await pgPool.query(SCHEMA, `
      SELECT * FROM doctor_log
      WHERE executed_at::timestamp > now() - ($1::text || ' days')::INTERVAL
      ORDER BY executed_at::timestamp DESC
      LIMIT 50
    `, [String(days)]);
  } catch (e) { console.warn('[doctor] doctor_log 조회 실패:', e.message); return []; }
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

// ─── Phase 3: agent_tasks 폴링 (팀장→독터 역할 분리) ─────────────────────────

/**
 * stateBus의 대기 태스크를 소화하여 복구 실행
 * 팀장(claude-lead)이 createTask로 발행한 복구 지시를 독터가 처리
 * dexter.js 마지막에 호출
 */
async function pollDoctorTasks() {
  const stateBus = require('./state-bus-bridge.js');
  let tasks;
  try {
    tasks = await stateBus.getPendingTasks('doctor');
  } catch (e) {
    console.warn('[doctor] 태스크 폴링 실패 (무시):', e.message);
    return;
  }
  if (!tasks || tasks.length === 0) return;

  console.log(`  [독터] 대기 태스크 ${tasks.length}건 처리 중...`);

  for (const task of tasks) {
    const taskType = task.task_type;
    let params = {};
    try {
      params = typeof task.payload === 'string'
        ? (JSON.parse(task.payload) ?? {})
        : (task.payload ?? {});
    } catch { /* 파싱 실패 시 빈 객체 */ }

    try {
      const result = await execute(taskType, params, task.from_agent || 'claude-lead');
      if (result.success) {
        await stateBus.completeTask(task.id, { message: result.message, data: result.data ?? null });
        // 팀장에게 복구 완료 이벤트 발행
        try {
          await stateBus.emitEvent('doctor', 'claude-lead', 'recovery_completed', {
            taskType,
            params,
            success: true,
            message:  result.message,
          });
        } catch { /* 이벤트 발행 실패 무시 */ }
        // RAG 저장: 복구 이력을 rag_operations에 학습 데이터로 기록
        try {
          const recoveryRagStore = require('../../../packages/core/lib/rag-safe');
          const content = [
            `장애 복구 성공: ${taskType}`,
            `원인: ${params.original_issue?.detail || params.reason || ''}`,
            `복구 방법: ${result.message || taskType}`,
          ].join(' | ');
          await publishToRag({
            ragStore: {
              async store(collection, ragContent, metadata = {}, sourceBot = 'doctor') {
                return recoveryRagStore.store(collection, ragContent, metadata, sourceBot);
              },
            },
            collection: 'operations',
            sourceBot: 'doctor',
            event: {
              from_bot: 'doctor',
              team: 'claude',
              event_type: 'doctor_recovery_rag',
              alert_level: 1,
              message: content,
              payload: {
                title: `복구 성공: ${taskType}`,
                summary: result.message || taskType,
                details: [
                  `원인: ${params.original_issue?.detail || params.reason || ''}`,
                ],
              },
            },
            metadata: {
              task_type: taskType,
              success: true,
              category: 'recovery',
              team: 'claude',
            },
            contentBuilder: () => content,
            policy: {
              dedupe: true,
              key: `doctor-recovery:${taskType}:${params.original_issue?.detail || params.reason || result.message || ''}`,
              cooldownMs: 12 * 60 * 60 * 1000,
            },
          });
        } catch (e) {
          console.warn('[doctor] RAG 저장 실패 (무시):', e.message);
        }
      } else {
        await stateBus.failTask(task.id, result.message);
        // RAG 저장: 복구 실패 이력 학습
        try {
          const failureRagStore = require('../../../packages/core/lib/rag-safe');
          const content = [
            `장애 복구 실패: ${taskType}`,
            `원인: ${params.original_issue?.detail || params.reason || ''}`,
            `실패 이유: ${result.message || '알 수 없음'}`,
          ].join(' | ');
          await publishToRag({
            ragStore: {
              async store(collection, ragContent, metadata = {}, sourceBot = 'doctor') {
                return failureRagStore.store(collection, ragContent, metadata, sourceBot);
              },
            },
            collection: 'operations',
            sourceBot: 'doctor',
            event: {
              from_bot: 'doctor',
              team: 'claude',
              event_type: 'doctor_recovery_failure_rag',
              alert_level: 1,
              message: content,
              payload: {
                title: `복구 실패: ${taskType}`,
                summary: result.message || '알 수 없음',
                details: [
                  `원인: ${params.original_issue?.detail || params.reason || ''}`,
                ],
              },
            },
            metadata: {
              task_type: taskType,
              success: false,
              category: 'recovery_failure',
              team: 'claude',
            },
            contentBuilder: () => content,
            policy: {
              dedupe: true,
              key: `doctor-recovery-failure:${taskType}:${params.original_issue?.detail || params.reason || result.message || ''}`,
              cooldownMs: 12 * 60 * 60 * 1000,
            },
          });
        } catch (e) {
          console.warn('[doctor] RAG 실패 이력 저장 실패 (무시):', e.message);
        }
      }
    } catch (e) {
      await stateBus.failTask(task.id, e.message).catch(() => {});
      console.error(`  [독터] 태스크 id=${task.id} 실행 오류:`, e.message);
    }
  }
}

function discoverServices() {
  let output = '';
  try {
    output = execSync('launchctl list', { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    console.warn('[doctor] launchctl list 실패:', err.message);
    return [];
  }

  const services = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const label = parts[2];
    if (!label || !label.startsWith('ai.')) continue;

    const pidRaw = parts[0];
    const statusRaw = parts[1];
    const plistPath = path.join(LAUNCHD_DIR, `${label}.plist`);
    let keepAlive = false;

    try {
      if (fs.existsSync(plistPath)) {
        const plistContent = execSync(`plutil -p "${plistPath}"`, { encoding: 'utf8', timeout: 3000 });
        keepAlive = /"KeepAlive"\s*=>\s*true\b/.test(plistContent);
      }
    } catch {
      keepAlive = false;
    }

    services.push({
      label,
      pid: pidRaw === '-' ? null : parseInt(pidRaw, 10),
      status: Number.parseInt(statusRaw, 10) || 0,
      keepAlive,
      plistPath: fs.existsSync(plistPath) ? plistPath : null,
      blacklisted: RECOVERY_BLACKLIST.has(label),
    });
  }

  return services;
}

function checkLaunchdHealth() {
  const services = discoverServices();
  const healthy = [];
  const down = [];
  const errors = [];
  const blacklisted = [];

  for (const svc of services) {
    if (svc.blacklisted) {
      blacklisted.push(svc);
      continue;
    }

    if (svc.pid) {
      healthy.push(svc);
    } else if (svc.keepAlive) {
      down.push(svc);
    } else if (svc.status !== 0) {
      errors.push({ ...svc, reason: `비정상 exit: ${svc.status}` });
    } else {
      healthy.push(svc);
    }
  }

  console.log(`[doctor] launchd 헬스: ${healthy.length}정상, ${down.length}내려감, ${errors.length}에러, ${blacklisted.length}블랙리스트`);
  return { healthy, down, errors, blacklisted, total: services.length };
}

async function recoverDownServices(downServices) {
  if (!downServices || downServices.length === 0) return [];

  const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
  const results = [];
  const uid = process.getuid ? process.getuid() : execSync('id -u', { encoding: 'utf8' }).trim();

  for (const svc of downServices) {
    try {
      console.log(`  🔧 [닥터] ${svc.label} 내려감 (exit: ${svc.status}) → 재시작`);
      kickstartLaunchdService(uid, svc.label, 15000);
      await logRecovery('restart_launchd_service', { label: svc.label }, { restarted: svc.label }, true, 'doctor-healthcheck');
      eventLake.record({
        eventType: 'doctor_recovery_success',
        team: 'claude',
        botName: 'doctor',
        severity: 'info',
        title: svc.label,
        message: 'launchd 자동 복구 성공',
        tags: ['doctor', 'recovery', 'launchd'],
        metadata: {
          label: svc.label,
          status: svc.status,
          source: 'launchd-healthcheck',
        },
      }).catch(() => {});
      results.push({ label: svc.label, success: true, message: '재시작 완료' });
    } catch (err) {
      await logRecovery('restart_launchd_service', { label: svc.label }, null, false, 'doctor-healthcheck', null, err.message);
      eventLake.record({
        eventType: 'doctor_recovery_failed',
        team: 'claude',
        botName: 'doctor',
        severity: 'error',
        title: svc.label,
        message: err.message,
        tags: ['doctor', 'recovery', 'failed'],
        metadata: {
          label: svc.label,
          status: svc.status,
          source: 'launchd-healthcheck',
        },
      }).catch(() => {});
      results.push({ label: svc.label, success: false, message: err.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (results.length > 0) {
    const lines = [`🏥 닥터 launchd 자동 복구 (${results.length}건)`];
    results.forEach((r) => lines.push(`  ${r.success ? '✅' : '❌'} ${r.label} — ${r.message}`));
    await publishToWebhook({
      event: {
        from_bot: 'doctor',
        team: 'claude',
        event_type: 'doctor_recovery_summary',
        alert_level: results.some((r) => r.label.includes('hub') || r.label.includes('mlx')) ? 3 : 2,
        message: lines.join('\n'),
      },
    });
  }

  return results;
}

async function scanAndRecover() {
  const { fetchOpsErrors } = require('../../../packages/core/lib/hub-client');
  const recoveries = [];

  try {
    const health = checkLaunchdHealth();
    if (health.down.length > 0) {
      const launchdRecoveries = await recoverDownServices(health.down);
      recoveries.push(...launchdRecoveries.map((r) => ({ ...r, source: 'launchd-healthcheck' })));
    }
  } catch (error) {
    console.warn('[doctor] launchd 헬스체크 실패:', error.message);
  }

  try {
    const data = await fetchOpsErrors(10);
    if (!data?.ok || data.total_errors === 0) return recoveries;

    for (const svc of data.services) {
      if (svc.error_count < 10) continue;

      const label = _serviceToLaunchd(svc.service);
      if (!label) continue;
      if (!canRecover('restart_launchd_service')) continue;
      if (RECOVERY_BLACKLIST.has(label)) continue;
      if (recoveries.some((r) => r.label === label && r.success)) continue;

      console.log(`  🔧 [닥터] ${svc.service} 에러 ${svc.error_count}건 → ${label} 재시작`);
      const result = await execute('restart_launchd_service', { label }, 'doctor-autoscan');
      eventLake.record({
        eventType: result.success ? 'doctor_error_threshold_recovered' : 'doctor_error_threshold_failed',
        team: 'claude',
        botName: 'doctor',
        severity: result.success ? 'warn' : 'error',
        title: svc.service,
        message: result.message,
        tags: ['doctor', 'autoscan', svc.service],
        metadata: {
          service: svc.service,
          label,
          error_count: svc.error_count,
        },
      }).catch(() => {});
      recoveries.push({
        service: svc.service,
        label,
        error_count: svc.error_count,
        success: result.success,
        message: result.message,
      });
    }
    return recoveries;
  } catch (error) {
    console.warn('[doctor] scanAndRecover 실패:', error.message);
    return recoveries;
  }
}

function _serviceToLaunchd(service) {
  const map = {
    'investment-crypto': 'ai.investment.crypto',
    'investment-domestic': null,
    'investment-overseas': null,
    dexter: 'ai.claude.dexter',
    'ska-commander': 'ai.ska.commander',
  };
  return map[service] || null;
}

/**
 * 과거 성공한 복구 방법 조회 (RAG 검색)
 * @param {string} issueType  task_type 또는 이슈 설명
 * @returns {Promise<string|null>} 과거 성공 복구 요약 또는 null
 */
async function getPastSuccessfulFix(issueType) {
  try {
    const ragSafe = require('../../../packages/core/lib/rag-safe');
    const results = await ragSafe.search('operations', `장애 복구 성공: ${issueType}`, {
      limit:     3,
      threshold: 0.6,
      filter:    { success: true, category: 'recovery' },
    });
    if (!results || results.length === 0) return null;
    return results.map(r => r.content || '').filter(Boolean).join(' / ');
  } catch {
    return null;
  }
}

// ─── Emergency 폴백: 클로드(팀장) 무응답 시 덱스터가 직접 호출 ──────────────

/**
 * 이슈 목록에서 자동 복구 가능한 작업을 직접 실행 (팀장 경유 없음)
 * Emergency 모드에서 agent_tasks 루프가 끊길 때 덱스터가 직접 호출
 *
 * @param {Array}  issues      { checkName, label, status, detail }[]
 * @param {string} requestedBy 'dexter-emergency'
 * @returns {Promise<{ issue, taskType, success, message }[]>}
 */
async function emergencyDirectRecover(issues, requestedBy = 'dexter-emergency') {
  // 이슈 → taskType 매핑 (claude-lead-brain.js의 _mapIssuesToDoctorTasks와 동일 정책)
  const ISSUE_MAP = [
    { match: l => l.includes('앤디')       || l.includes('naver-monitor'),     taskType: 'restart_launchd_service', params: { label: 'ai.ska.naver-monitor' } },
    { match: l => l.includes('지미')       || l.includes('kiosk-monitor'),     taskType: 'restart_launchd_service', params: { label: 'ai.ska.kiosk-monitor' } },
    { match: l => l.includes('스카 커맨더') || l.includes('ska.commander'),     taskType: 'restart_launchd_service', params: { label: 'ai.ska.commander' } },
    { match: l => l.includes('루나 커맨더') || l.includes('investment.commander'), taskType: 'restart_launchd_service', params: { label: 'ai.investment.commander' } },
  ];

  const results = [];
  const seen    = new Set();

  for (const issue of issues) {
    const label = (issue.label || '').toLowerCase();
    for (const rule of ISSUE_MAP) {
      if (!rule.match(label)) continue;
      const key = `${rule.taskType}:${JSON.stringify(rule.params)}`;
      if (seen.has(key)) break;  // 중복 방지
      seen.add(key);

      console.log(`  🚨 [Emergency 폴백] 직접 복구 — ${rule.taskType}(${JSON.stringify(rule.params)})`);
      try {
        const r = await execute(rule.taskType, rule.params, requestedBy);
        results.push({ issue: issue.label, taskType: rule.taskType, success: r.success, message: r.message });
      } catch (e) {
        results.push({ issue: issue.label, taskType: rule.taskType, success: false, message: e.message });
      }
      break;
    }
  }
  return results;
}



// ─── Phase D: Verify Loop (Claude Forge 패턴) ────────────────────────────────

const RETRY_BACKOFF_MS = [5000, 15000, 45000];  // 5s → 15s → 45s
const MAX_RETRY = 3;

/**
 * 복구 후 검증 — 작업 타입별 실제 확인 로직
 * @param {string} taskType
 * @param {object} params
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function verifyRecovery(taskType, params) {
  try {
    switch (taskType) {
      case 'restart_launchd_service': {
        await new Promise(r => setTimeout(r, 3000));
        const label = params.label;
        const status = execSync(`launchctl list ${label} 2>&1`, { encoding: 'utf8', timeout: 5000 }).trim();
        const isRunning = !status.includes('Could not find service') && !status.includes('No such process');
        return { ok: isRunning, detail: status.slice(0, 200) };
      }

      case 'git_stash': {
        const stashList = execSync('git stash list', { encoding: 'utf8', cwd: ROOT, timeout: 5000 }).trim();
        const found = params.message ? stashList.includes(params.message) : stashList.length > 0;
        return { ok: found, detail: stashList.slice(0, 200) };
      }

      case 'clear_lock_file': {
        const lockExists = fs.existsSync(params.path);
        return { ok: !lockExists, detail: `lock_exists=${lockExists}` };
      }

      case 'clear_expired_cache':
        // 캐시 정리는 항상 성공으로 간주
        return { ok: true, detail: 'cache_clear_verified' };

      case 'npm_audit_fix': {
        // npm audit 재실행으로 critical 감소 확인
        try {
          const output = execSync('npm audit --json 2>/dev/null || true', {
            cwd: params.cwd || ROOT,
            encoding: 'utf8',
            timeout: 15000,
          });
          const audit = JSON.parse(output);
          const criticals = Object.values(audit.vulnerabilities || {})
            .filter(v => (v as any).severity === 'critical').length;
          return { ok: criticals === 0, detail: `critical_count=${criticals}` };
        } catch {
          return { ok: true, detail: 'no_verify_required' };
        }
      }

      case 'fix_file_permissions': {
        const mode = (fs.statSync(params.filePath).mode & 0o777).toString(8);
        return { ok: mode === '600', detail: `mode=${mode}` };
      }

      default:
        return { ok: true, detail: 'no_verify_required' };
    }
  } catch (e) {
    return { ok: false, detail: `verify_error: ${e.message}` };
  }
}

/**
 * Verify Loop — 복구 → 검증 → 실패 시 재시도 (최대 3회)
 * Claude Forge /verify-loop 패턴 적용
 *
 * @param {string} taskType       - WHITELIST 키
 * @param {object} params         - 작업 파라미터
 * @param {string} requestedBy    - 요청자
 * @returns {Promise<RecoveryResult & { attempts: number, verified: boolean }>}
 */
async function executeWithVerifyLoop(taskType, params = {}, requestedBy = 'claude-commander') {
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    // 재시도 시 백오프
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 2]));
    }

    // 실행
    const result = await execute(taskType, params, requestedBy);
    lastResult = result;

    if (!result.success) {
      if (attempt < MAX_RETRY) {
        console.log(`[doctor] Verify Loop 시도 ${attempt}/${MAX_RETRY} 실패 — 재시도`);
        continue;
      }
      // 최대 재시도 초과
      await _logVerifyLoop(taskType, params, requestedBy, attempt, false, false, result.message);
      return { ...result, attempts: attempt, verified: false };
    }

    // 검증
    const verified = await verifyRecovery(taskType, params);

    if (verified.ok) {
      console.log(`[doctor] Verify Loop 성공 (${attempt}회): ${taskType} — ${verified.detail}`);
      await _logVerifyLoop(taskType, params, requestedBy, attempt, true, true, null);
      return { ...result, attempts: attempt, verified: true };
    }

    // 검증 실패
    console.log(`[doctor] Verify Loop 검증 실패 (${attempt}/${MAX_RETRY}): ${verified.detail}`);

    if (attempt >= MAX_RETRY) {
      // 3회 모두 실패 — 긴급 알림
      try {
        const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
        await postAlarm({
          message: `🚨 [독터] Verify Loop 최종 실패\n작업: ${taskType}\n${MAX_RETRY}회 시도 후 검증 실패\n상세: ${verified.detail}`,
          team: 'claude',
          alertLevel: 4,
          fromBot: 'doctor',
        });
      } catch {}
      await _logVerifyLoop(taskType, params, requestedBy, attempt, true, false, verified.detail);
      return { ...result, success: false, message: `Verify Loop 최종 실패 (${MAX_RETRY}회): ${verified.detail}`, attempts: attempt, verified: false };
    }
  }

  return { success: false, message: 'Verify Loop 종료', attempts: MAX_RETRY, verified: false };
}

async function _logVerifyLoop(taskType, params, requestedBy, attempts, executed, verified, errorMsg) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO claude_doctor_recovery_log
        (action, params, caller_bot, attempts, success, verified, error_msg)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      taskType,
      JSON.stringify(params ?? null),
      requestedBy,
      attempts,
      executed && verified ? 1 : 0,
      verified ? 1 : 0,
      errorMsg ?? null,
    ]);
  } catch (e) {
    console.warn('[doctor] claude_doctor_recovery_log INSERT 실패 (무시):', e.message);
  }
}

export {
  execute,
  executeWithVerifyLoop,
  verifyRecovery,
  canRecover,
  logRecovery,
  getRecoveryHistory,
  getAvailableTasks,
  pollDoctorTasks,
  discoverServices,
  checkLaunchdHealth,
  recoverDownServices,
  scanAndRecover,
  emergencyDirectRecover,
  getPastSuccessfulFix,
  WHITELIST,
  BLACKLIST,
};
