const { execSync } = require('child_process') as typeof import('node:child_process');
const { cached } = require('../lib/response-cache') as {
  cached: <T>(key: string, fn: () => Promise<T>, ttlMs: number) => Promise<T>;
};
const pgPool = require('../../../packages/core/lib/pg-pool') as {
  query: (schema: string, sql: string, params?: any[]) => Promise<any[]>;
  get: (schema: string, sql: string, params?: any[]) => Promise<any>;
};
const kst = require('../../../packages/core/lib/kst') as { today: () => string };

type LaunchdService = {
  id: string;
  name: string;
};

type LaunchdStatus = {
  running: boolean;
  pid: number | null;
};

type AgentStatusRow = {
  agent: string;
  status: string;
  current_task?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
};

type QueueStats = {
  total?: number;
  sent?: number;
  muted?: number;
  deferred?: number;
  pending?: number;
  max_level?: number;
};

type RecentAlertRow = {
  from_bot: string;
  alert_level: number;
  message: string;
};

type ActiveMuteRow = {
  target: string;
  mute_until: string;
};

const LAUNCHD_SERVICES: LaunchdService[] = [
  { id: 'ai.openclaw.gateway', name: 'OpenClaw 게이트웨이' },
  { id: 'ai.orchestrator', name: '메인봇' },
  { id: 'ai.reservation.monitor', name: '앤디(네이버모니터)' },
  { id: 'ai.kiosk.monitor', name: '지미(키오스크)' },
  { id: 'ai.investment.crypto', name: '루나팀 크립토' },
  { id: 'ai.invest.dev', name: '루나 Phase0 DEV' },
  { id: 'ai.claude.dexter', name: '덱스터' },
  { id: 'ai.claude.archer', name: '아처' },
];

function checkLaunchd(serviceId: string): LaunchdStatus {
  try {
    const output = execSync(`launchctl list ${serviceId} 2>/dev/null`, { timeout: 3000 }).toString();
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) return { running: true, pid: parseInt(pidMatch[1], 10) };
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

async function getAgentStatuses(): Promise<AgentStatusRow[]> {
  try {
    return await pgPool.query(
      'claude',
      `
      SELECT agent, status, current_task, last_success_at, last_error, updated_at
      FROM agent_state
      ORDER BY agent
    `,
    );
  } catch {
    return [];
  }
}

async function getQueueStats(): Promise<QueueStats> {
  try {
    const today = kst.today();
    return (
      await pgPool.get(
        'claude',
        `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='muted'    THEN 1 ELSE 0 END) AS muted,
        SUM(CASE WHEN status='deferred' THEN 1 ELSE 0 END) AS deferred,
        SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
        MAX(alert_level) AS max_level
      FROM mainbot_queue
      WHERE created_at::date = $1::date
    `,
        [today],
      )
    ) || {};
  } catch {
    return {};
  }
}

async function getRecentAlerts(): Promise<RecentAlertRow[]> {
  try {
    return await pgPool.query(
      'claude',
      `
      SELECT from_bot, event_type, alert_level, message, created_at
      FROM mainbot_queue
      ORDER BY created_at DESC
      LIMIT 5
    `,
    );
  } catch {
    return [];
  }
}

async function getActiveMutes(): Promise<ActiveMuteRow[]> {
  try {
    const now = new Date().toISOString();
    return await pgPool.query(
      'claude',
      `
      SELECT target, mute_until, reason
      FROM mute_settings
      WHERE mute_until > $1
    `,
      [now],
    );
  } catch {
    return [];
  }
}

const STATUS_ICONS: Record<string, string> = { running: '✅', error: '❌', idle: '🔵', unknown: '⚪' };
const ALERT_ICONS: Record<number, string> = { 1: '🔵', 2: '🟡', 3: '🟠', 4: '🔴' };

export async function buildStatus(): Promise<string> {
  return cached('status', async () => {
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const agents = await getAgentStatuses();
    const queueStats = await getQueueStats();
    const mutes = await getActiveMutes();
    const recents = await getRecentAlerts();

    const lines = [`🤖 JayLabs 시스템 현황`, `📅 ${kstNow} KST`, ``];

    lines.push(`⚙️ 서비스`);
    for (const service of LAUNCHD_SERVICES) {
      const { running, pid } = checkLaunchd(service.id);
      const icon = running ? '✅' : '❌';
      const pidText = pid ? ` (PID ${pid})` : '';
      lines.push(`  ${icon} ${service.name}${pidText}`);
    }
    lines.push('');

    if (agents.length > 0) {
      lines.push(`🤖 에이전트`);
      for (const agent of agents) {
        const icon = STATUS_ICONS[agent.status] || '⚪';
        const task = agent.current_task ? ` — ${agent.current_task}` : '';
        const lastOk = agent.last_success_at ? ` (${agent.last_success_at.slice(0, 16)})` : '';
        lines.push(`  ${icon} ${agent.agent}${task}${lastOk}`);
        if (agent.status === 'error' && agent.last_error) {
          lines.push(`       ⚠️ ${agent.last_error.slice(0, 60)}`);
        }
      }
      lines.push('');
    }

    lines.push(`📬 오늘 알람 큐`);
    lines.push(`  총 ${queueStats.total || 0}건 | 발송 ${queueStats.sent || 0} | 무음 ${queueStats.muted || 0} | 보류 ${queueStats.deferred || 0} | 대기 ${queueStats.pending || 0}`);
    lines.push('');

    if (mutes.length > 0) {
      lines.push(`🔇 무음 설정`);
      for (const mute of mutes) {
        lines.push(`  • ${mute.target} → ${mute.mute_until.slice(0, 16)} KST`);
      }
      lines.push('');
    }

    if (recents.length > 0) {
      lines.push(`📋 최근 알람`);
      for (const recent of recents) {
        const icon = ALERT_ICONS[recent.alert_level] || '⚪';
        lines.push(`  ${icon} [${recent.from_bot}] ${recent.message.split('\n')[0].slice(0, 50)}`);
      }
    }

    return lines.join('\n').trim();
  }, 60_000);
}
