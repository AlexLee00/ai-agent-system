'use strict';

/**
 * src/dashboard.js — /status 대시보드 생성
 *
 * claude-team.db 조회 + launchd 상태 + 최근 큐 통계
 */

const { execSync }       = require('child_process');
const { cached }         = require('../lib/response-cache');
const path               = require('path');
const os                 = require('os');
const fs                 = require('fs');
const Database           = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// launchd 서비스 목록
const LAUNCHD_SERVICES = [
  { id: 'ai.openclaw.gateway',    name: 'OpenClaw 게이트웨이' },
  { id: 'ai.orchestrator',        name: '메인봇'              },
  { id: 'ai.reservation.monitor', name: '앤디(네이버모니터)'  },
  { id: 'ai.kiosk.monitor',       name: '지미(키오스크)'      },
  { id: 'ai.investment.crypto',   name: '루나팀 크립토'       },
  { id: 'ai.invest.dev',          name: '루나 Phase0 DEV'     },
  { id: 'ai.claude.dexter',       name: '덱스터'              },
  { id: 'ai.claude.archer',       name: '아처'                },
];

function checkLaunchd(serviceId) {
  try {
    const out = execSync(`launchctl list ${serviceId} 2>/dev/null`, { timeout: 3000 }).toString();
    // PID가 있으면 실행 중
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) return { running: true, pid: parseInt(pidMatch[1]) };
    // ExitStatus가 있으면 종료됨
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

/**
 * 에이전트 상태 조회
 */
function getAgentStatuses() {
  try {
    return getDb().prepare(`
      SELECT agent, status, current_task, last_success_at, last_error, updated_at
      FROM agent_state
      ORDER BY agent
    `).all();
  } catch { return []; }
}

/**
 * 오늘 큐 통계
 */
function getQueueStats() {
  try {
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];
    return getDb().prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='muted'    THEN 1 ELSE 0 END) AS muted,
        SUM(CASE WHEN status='deferred' THEN 1 ELSE 0 END) AS deferred,
        SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
        MAX(alert_level) AS max_level
      FROM mainbot_queue
      WHERE date(created_at) = ?
    `).get(today) || {};
  } catch { return {}; }
}

/**
 * 최근 알람 (최대 5건)
 */
function getRecentAlerts() {
  try {
    return getDb().prepare(`
      SELECT from_bot, event_type, alert_level, message, created_at
      FROM mainbot_queue
      ORDER BY created_at DESC
      LIMIT 5
    `).all();
  } catch { return []; }
}

/**
 * 활성 무음 목록
 */
function getActiveMutes() {
  try {
    const now = new Date().toISOString();
    return getDb().prepare(`
      SELECT target, mute_until, reason
      FROM mute_settings
      WHERE mute_until > ?
    `).all(now);
  } catch { return []; }
}

const STATUS_ICONS = { running: '✅', error: '❌', idle: '🔵', unknown: '⚪' };
const ALERT_ICONS  = { 1: '🔵', 2: '🟡', 3: '🟠', 4: '🔴' };

/**
 * /status 텍스트 생성 (60초 캐시)
 */
async function buildStatus() {
  return cached('status', async () => {
    const kstNow   = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const agents   = getAgentStatuses();
    const qStats   = getQueueStats();
    const mutes    = getActiveMutes();
    const recents  = getRecentAlerts();

    const lines = [
      `🤖 JayLabs 시스템 현황`,
      `📅 ${kstNow} KST`,
      ``,
    ];

    // ── launchd 서비스 상태
    lines.push(`⚙️ 서비스`);
    for (const svc of LAUNCHD_SERVICES) {
      const { running, pid } = checkLaunchd(svc.id);
      const icon = running ? '✅' : '❌';
      const pidStr = pid ? ` (PID ${pid})` : '';
      lines.push(`  ${icon} ${svc.name}${pidStr}`);
    }
    lines.push('');

    // ── 에이전트 상태 (team-bus)
    if (agents.length > 0) {
      lines.push(`🤖 에이전트`);
      for (const a of agents) {
        const icon    = STATUS_ICONS[a.status] || '⚪';
        const task    = a.current_task ? ` — ${a.current_task}` : '';
        const lastOk  = a.last_success_at ? ` (${a.last_success_at.slice(0, 16)})` : '';
        lines.push(`  ${icon} ${a.agent}${task}${lastOk}`);
        if (a.status === 'error' && a.last_error) {
          lines.push(`       ⚠️ ${a.last_error.slice(0, 60)}`);
        }
      }
      lines.push('');
    }

    // ── 오늘 큐 통계
    lines.push(`📬 오늘 알람 큐`);
    lines.push(`  총 ${qStats.total || 0}건 | 발송 ${qStats.sent || 0} | 무음 ${qStats.muted || 0} | 보류 ${qStats.deferred || 0} | 대기 ${qStats.pending || 0}`);
    lines.push('');

    // ── 활성 무음
    if (mutes.length > 0) {
      lines.push(`🔇 무음 설정`);
      for (const m of mutes) {
        const until = m.mute_until.slice(0, 16);
        lines.push(`  • ${m.target} → ${until} KST`);
      }
      lines.push('');
    }

    // ── 최근 알람
    if (recents.length > 0) {
      lines.push(`📋 최근 알람`);
      for (const r of recents) {
        const icon = ALERT_ICONS[r.alert_level] || '⚪';
        lines.push(`  ${icon} [${r.from_bot}] ${r.message.split('\n')[0].slice(0, 50)}`);
      }
    }

    return lines.join('\n').trim();
  }, 60_000);
}

module.exports = { buildStatus };
