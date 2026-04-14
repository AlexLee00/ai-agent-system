const { execSync } = require('child_process') as typeof import('node:child_process');
const { cached } = require('../lib/response-cache') as {
  cached: <T>(key: string, fn: () => Promise<T>, ttlMs: number) => Promise<T>;
};
const pgPool = require('../../../packages/core/lib/pg-pool') as {
  query: (schema: string, sql: string, params?: any[]) => Promise<any[]>;
  get: (schema: string, sql: string, params?: any[]) => Promise<any>;
};
const {
  readRecentAlertSnapshot,
} = require('../../../packages/core/lib/openclaw-client') as {
  readRecentAlertSnapshot: (limit?: number) => any[];
};

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

type AlertSnapshotStats = {
  total: number;
  eventTagged: number;
  high: number;
  critical: number;
};

type RecentAlertRow = {
  from_bot: string;
  alert_level: number;
  message: string;
  event_type?: string | null;
  created_at?: string;
};

type ActiveMuteRow = {
  target: string;
  mute_until: string;
};

const LAUNCHD_SERVICES: LaunchdService[] = [
  { id: 'ai.openclaw.gateway', name: 'OpenClaw 게이트웨이' },
  { id: 'ai.orchestrator', name: '오케스트레이터' },
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

function getRecentAlertStats(): AlertSnapshotStats {
  try {
    const rows = readRecentAlertSnapshot(50) as RecentAlertRow[];
    return {
      total: rows.length,
      eventTagged: rows.filter((row) => row.event_type).length,
      high: rows.filter((row) => Number(row.alert_level) >= 3).length,
      critical: rows.filter((row) => Number(row.alert_level) >= 4).length,
    };
  } catch {
    return { total: 0, eventTagged: 0, high: 0, critical: 0 };
  }
}

function getRecentAlerts(): RecentAlertRow[] {
  try {
    return readRecentAlertSnapshot(5) as RecentAlertRow[];
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
    const alertStats = getRecentAlertStats();
    const mutes = await getActiveMutes();
    const recents = getRecentAlerts();

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

    lines.push(`📬 최근 알람 snapshot`);
    lines.push(`  총 ${alertStats.total}건 | 이벤트태그 ${alertStats.eventTagged} | 높음 ${alertStats.high} | 긴급 ${alertStats.critical}`);
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
        const time = recent.created_at ? ` ${String(recent.created_at).slice(11, 16)}` : '';
        lines.push(`  ${icon}${time} [${recent.from_bot}] ${recent.message.split('\n')[0].slice(0, 50)}`);
      }
    }

    return lines.join('\n').trim();
  }, 60_000);
}
