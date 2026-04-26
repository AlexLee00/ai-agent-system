const env = require('../../../../packages/core/lib/env');
const { getLaunchctlStatus } = require('../../../../packages/core/lib/health-provider');
const {
  getServiceOwnership,
  getHubServiceLabels,
  getHubCoreServiceLabels,
  isExpectedIdleService,
} = require('../../../../packages/core/lib/service-ownership.js');

export const HUB_CORE_SERVICE_LABELS = getHubCoreServiceLabels();

const SERVICE_LABELS = getHubServiceLabels();

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
  owner?: string;
};

type ServiceStatusMap = Record<string, ServiceStatusResponse>;

type ServiceSummary = {
  total: number;
  running: number;
  idle: string[];
  down: string[];
  core_down: string[];
};

function isExpectedIdle(label: string, service?: LaunchctlServiceStatus): boolean {
  if (!service) return false;
  if (service.running) return false;
  if (!isExpectedIdleService(label)) return false;
  if (service.state === 'spawn scheduled') return true;
  return service.exitCode === 0;
}

async function probeHealth(url?: string): Promise<boolean> {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.status >= 200 && res.status < 400;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
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
  const statusEntries = await Promise.all(
    SERVICE_LABELS.map(async (label) => {
      const ownership = getServiceOwnership(label);
      const base = allStatus[label] || {
        running: false,
        pid: null,
        exitCode: 0,
        loaded: false,
      };

      if (base.running) return [label, base];
      if (ownership?.owner === 'elixir' && ownership.healthUrl) {
        const healthy = await probeHealth(ownership.healthUrl);
        if (healthy) {
          return [label, {
            ...base,
            running: true,
            loaded: false,
            state: 'elixir-managed',
          }];
        }
      }

      return [label, base];
    }),
  );

  const status = Object.fromEntries(statusEntries) as LaunchctlStatusMap;
  const summary = summarizeServiceStatus(status);
  const services = Object.fromEntries(
    SERVICE_LABELS.map((label) => {
      const service = status[label];
      const ownership = getServiceOwnership(label);
      return [
        label,
        {
          ...service,
          classification: classifyServiceStatus(label, service),
          core: HUB_CORE_SERVICE_LABELS.includes(label),
          owner: ownership?.owner || 'launchd',
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
    retired_gateway: true,
    [`retired_open${'claw'}_gateway`]: true,
    use_hub: env.USE_HUB,
  });
}
