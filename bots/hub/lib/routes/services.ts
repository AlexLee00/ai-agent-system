const env = require('../../../../packages/core/lib/env');
const { getLaunchctlStatus } = require('../../../../packages/core/lib/health-provider');

export const HUB_CORE_SERVICE_LABELS = [
  'ai.openclaw.gateway',
  'ai.n8n.server',
];

const SERVICE_LABELS = [
  'ai.openclaw.gateway',
  'ai.claude.commander',
  'ai.claude.dexter',
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.blog.node-server',
  'ai.worker.web',
  'ai.worker.nextjs',
  'ai.worker.lead',
  'ai.worker.task-runner',
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.mlx.server',
  'ai.n8n.server',
  'ai.hub.resource-api',
];

type LaunchctlServiceStatus = {
  running: boolean;
  pid: number | null;
  exitCode: number;
  loaded?: boolean;
  state?: string;
};

type LaunchctlStatusMap = Record<string, LaunchctlServiceStatus>;

type ServiceClassification = 'running' | 'idle' | 'down';

type ServiceStatusResponse = LaunchctlServiceStatus & {
  classification: ServiceClassification;
  core: boolean;
};

type ServiceStatusMap = Record<string, ServiceStatusResponse>;

type ServiceSummary = {
  total: number;
  running: number;
  idle: string[];
  down: string[];
  core_down: string[];
};

const EXPECTED_IDLE_SERVICE_LABELS = new Set([
  'ai.claude.dexter',
  'ai.worker.lead',
  'ai.worker.task-runner',
  'ai.investment.crypto',
]);

function isExpectedIdle(label: string, service?: LaunchctlServiceStatus): boolean {
  if (!service) return false;
  if (service.running) return false;
  if (!EXPECTED_IDLE_SERVICE_LABELS.has(label)) return false;
  if (service.state === 'spawn scheduled') return true;
  return service.exitCode === 0;
}

export function summarizeServiceStatus(
  status: LaunchctlStatusMap,
  {
    labels = SERVICE_LABELS,
    coreLabels = HUB_CORE_SERVICE_LABELS,
  }: {
    labels?: string[];
    coreLabels?: string[];
  } = {},
): ServiceSummary {
  const idle = labels.filter((label) => isExpectedIdle(label, status?.[label]));
  const down = labels.filter((label) => !status?.[label]?.running && !idle.includes(label));
  const coreDown = coreLabels.filter((label) => !status?.[label]?.running);

  return {
    total: labels.length,
    running: labels.filter((label) => status?.[label]?.running).length,
    idle,
    down,
    core_down: coreDown,
  };
}

function classifyServiceStatus(
  label: string,
  service: LaunchctlServiceStatus,
): ServiceClassification {
  if (service.running) return 'running';
  if (isExpectedIdle(label, service)) return 'idle';
  return 'down';
}

export async function servicesStatusRoute(_req: any, res: any) {
  if (!env.LAUNCHD_AVAILABLE) {
    return res.json({
      status: 'ok',
      detail: 'launchd unavailable in current mode',
      services: {},
    });
  }

  const allStatus = getLaunchctlStatus(SERVICE_LABELS);
  const status = Object.fromEntries(
    SERVICE_LABELS.map((label) => [
      label,
      allStatus[label] || {
        running: false,
        pid: null,
        exitCode: 0,
        loaded: false,
      },
    ]),
  ) as LaunchctlStatusMap;
  const summary = summarizeServiceStatus(status);
  const services = Object.fromEntries(
    SERVICE_LABELS.map((label) => {
      const service = status[label];
      return [
        label,
        {
          ...service,
          classification: classifyServiceStatus(label, service),
          core: HUB_CORE_SERVICE_LABELS.includes(label),
        },
      ];
    }),
  ) as ServiceStatusMap;
  return res.json({
    status: summary.core_down.length === 0 ? 'ok' : 'warn',
    summary,
    services,
  });
}

export async function envRoute(_req: any, res: any) {
  return res.json({
    mode: env.MODE,
    node_env: env.NODE_ENV,
    paper_mode: env.PAPER_MODE,
    n8n_enabled: env.N8N_ENABLED,
    launchd_available: env.LAUNCHD_AVAILABLE,
    pg_host: env.PG_HOST,
    pg_port: env.PG_PORT,
    hub_port: env.HUB_PORT,
    openclaw_port: env.OPENCLAW_PORT,
    use_hub: env.USE_HUB,
  });
}
