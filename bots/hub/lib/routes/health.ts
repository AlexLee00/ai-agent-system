const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { checkHttp } = require('../../../../packages/core/lib/health-provider');
const PG_POOL_WARN_THRESHOLD = 0.8;

type HealthResource = {
  status: 'ok' | 'warn';
  detail: string;
  latency_ms?: number;
};

type HealthResources = Record<string, HealthResource>;

type HealthSnapshot = {
  status: 'ok' | 'warn';
  mode: string;
  uptime_s: number;
  latency_ms: number;
  resources: HealthResources;
};

export async function collectHealthSnapshot(): Promise<HealthSnapshot> {
  const started = Date.now();
  const resources: HealthResources = {};
  const poolHealth = pgPool.checkPoolHealth?.(PG_POOL_WARN_THRESHOLD);

  try {
    const pgStart = Date.now();
    await pgPool.query('public', 'SELECT 1 AS ok');
    resources.postgresql = {
      status: 'ok',
      detail: 'query ok',
      latency_ms: Date.now() - pgStart,
    };
  } catch (error: any) {
    resources.postgresql = {
      status: 'warn',
      detail: String(error?.message || 'pg_failed'),
    };
  }

  if (poolHealth?.issues?.length) {
    resources.pg_pool = {
      status: 'warn',
      detail: poolHealth.issues.map((issue: any) => `${issue.schema}: ${issue.detail}`).join(' | '),
    };
  } else {
    resources.pg_pool = {
      status: 'ok',
      detail: 'pool healthy',
    };
  }

  if (env.N8N_ENABLED) {
    const n8nStart = Date.now();
    const ok = await checkHttp(`${env.N8N_BASE_URL}/healthz`, 3000);
    resources.n8n = {
      status: ok ? 'ok' : 'warn',
      detail: ok ? 'health ok' : 'health unreachable',
      latency_ms: Date.now() - n8nStart,
    };
  } else {
    resources.n8n = {
      status: 'ok',
      detail: 'disabled in current mode',
    };
  }

  const hasWarn = Object.values(resources).some((item) => item.status !== 'ok');

  return {
    status: hasWarn ? 'warn' : 'ok',
    mode: env.MODE,
    uptime_s: Math.round(process.uptime()),
    latency_ms: Date.now() - started,
    resources,
  };
}

export async function healthRoute(_req: any, res: any) {
  const snapshot = await collectHealthSnapshot();
  return res.json(snapshot);
}

export async function healthReadyRoute(_req: any, res: any) {
  const snapshot = await collectHealthSnapshot();
  return res.status(snapshot.status === 'ok' ? 200 : 503).json({
    ...snapshot,
    ready: snapshot.status === 'ok',
  });
}
