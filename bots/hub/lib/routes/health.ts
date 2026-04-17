const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { createHealthMemoryHelper } = require('../../../../packages/core/lib/health-memory');
const { checkHttp, getLaunchctlStatus } = require('../../../../packages/core/lib/health-provider');
const { getServiceCatalog } = require('../../../../packages/core/lib/service-ownership');
const {
  HUB_CORE_SERVICE_LABELS,
  summarizeServiceStatus,
} = require('./services') as {
  HUB_CORE_SERVICE_LABELS: string[];
  summarizeServiceStatus: (status: Record<string, { running: boolean }>, opts?: { labels?: string[]; coreLabels?: string[] }) => {
    total: number;
    running: number;
    down: string[];
    core_down: string[];
  };
};
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
  memory_hints?: {
    recent_patterns?: string;
  };
  readiness_summary: {
    core_service_total: number;
    core_service_down: number;
    resource_warn_count: number;
  };
};

const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'hub.health',
  team: 'hub',
  domain: 'hub health',
});
let lastRecordedStatus: 'ok' | 'warn' | null = null;

async function fetchJson(url: string, timeoutMs = 3000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

  const localLlmStart = Date.now();
  const localLlmJson = await fetchJson(`${env.LOCAL_LLM_BASE_URL}/v1/models`, 4000);
  const localLlmModels = Array.isArray(localLlmJson?.data)
    ? localLlmJson.data.map((item: any) => item?.id).filter(Boolean)
    : [];
  resources.local_llm = localLlmModels.length > 0
    ? {
        status: 'ok',
        detail: `models ${localLlmModels.length}개 (${localLlmModels.slice(0, 4).join(', ')})`,
        latency_ms: Date.now() - localLlmStart,
      }
    : {
        status: 'warn',
        detail: `unreachable or invalid response (${env.LOCAL_LLM_BASE_URL}/v1/models)`,
        latency_ms: Date.now() - localLlmStart,
      };

  try {
    const ragRows = await pgPool.query('rag', `
      SELECT count(*)::int AS total_count, max(created_at) AS latest_created_at
      FROM rag.agent_memory
    `);
    const row = ragRows?.[0] || {};
    const totalCount = Number(row.total_count || 0);
    const latestCreatedAt = row.latest_created_at ? String(row.latest_created_at) : null;
    resources.rag = {
      status: 'ok',
      detail: `agent_memory ${totalCount}건${latestCreatedAt ? `, latest ${latestCreatedAt}` : ''}`,
    };
  } catch (error: any) {
    resources.rag = {
      status: 'warn',
      detail: String(error?.message || 'rag query failed'),
    };
  }

  try {
    const ownershipRows = await pgPool.query('agent', `
      SELECT metadata->'ownership_alignment' AS ownership_alignment
      FROM agent.event_lake
      WHERE event_type = 'phase3_shadow_report'
        AND bot_name = 'diagnostics'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const ownership = ownershipRows?.[0]?.ownership_alignment || {};
    const message = String(ownership?.message || 'ownership alignment unavailable');
    const missingFromRuntime = Array.isArray(ownership?.missing_from_runtime) ? ownership.missing_from_runtime : [];
    const missingFromManifest = Array.isArray(ownership?.missing_from_manifest) ? ownership.missing_from_manifest : [];
    const driftCount = missingFromRuntime.length + missingFromManifest.length;

    resources.ownership_alignment = driftCount === 0
      ? {
          status: 'ok',
          detail: message,
        }
      : {
          status: 'warn',
          detail: `${message} | runtime_missing=${missingFromRuntime.join(', ') || 'none'} | manifest_missing=${missingFromManifest.join(', ') || 'none'}`,
        };
  } catch (error: any) {
    resources.ownership_alignment = {
      status: 'warn',
      detail: String(error?.message || 'ownership query failed'),
    };
  }

  try {
    const daemonCandidates = getServiceCatalog()
      .filter((entry: any) => entry?.owner === 'elixir' && entry?.healthUrl);

    const daemonResults = await Promise.all(
      daemonCandidates.map(async (entry: any) => {
        if (String(entry.label) === 'ai.hub.resource-api') {
          return {
            label: String(entry.label),
            ok: true,
          };
        }

        const ok = await checkHttp(String(entry.healthUrl), 3000);
        return {
          label: String(entry.label),
          ok,
        };
      })
    );

    const down = daemonResults.filter((item) => !item.ok).map((item) => item.label);
    const up = daemonResults.filter((item) => item.ok).map((item) => item.label);

    resources.daemon_cutover = down.length === 0
      ? {
          status: 'ok',
          detail: `healthy ${up.length}/${daemonResults.length}${up.length > 0 ? ` (${up.join(', ')})` : ''}`,
        }
      : {
          status: 'warn',
          detail: `healthy ${up.length}/${daemonResults.length} | down=${down.join(', ')}`,
        };
  } catch (error: any) {
    resources.daemon_cutover = {
      status: 'warn',
      detail: String(error?.message || 'daemon cutover probe failed'),
    };
  }

  if (env.LAUNCHD_AVAILABLE) {
    const serviceStatus = getLaunchctlStatus(HUB_CORE_SERVICE_LABELS);
    const summary = summarizeServiceStatus(serviceStatus, {
      labels: HUB_CORE_SERVICE_LABELS,
      coreLabels: HUB_CORE_SERVICE_LABELS,
    });
    resources.core_services = summary.core_down.length === 0
      ? {
          status: 'ok',
          detail: 'core launchd services healthy',
        }
      : {
          status: 'warn',
          detail: summary.core_down.join(', '),
        };
  }

  const resourceWarnCount = Object.values(resources).filter((item) => item.status !== 'ok').length;
  const coreServiceDown = resources.core_services?.status === 'warn'
    ? resources.core_services.detail.split(',').map((value) => value.trim()).filter(Boolean).length
    : 0;
  const hasWarn = resourceWarnCount > 0;

  return {
    status: hasWarn ? 'warn' : 'ok',
    mode: env.MODE,
    uptime_s: Math.round(process.uptime()),
    latency_ms: Date.now() - started,
    resources,
    readiness_summary: {
      core_service_total: HUB_CORE_SERVICE_LABELS.length,
      core_service_down: coreServiceDown,
      resource_warn_count: resourceWarnCount,
    },
  };
}

export async function healthRoute(_req: any, res: any) {
  const snapshot = await collectHealthSnapshot();
  return res.json(snapshot);
}

export async function healthReadyRoute(_req: any, res: any) {
  const snapshot = await collectHealthSnapshot();
  const issueKey = snapshot.resources.core_services?.status === 'warn'
    ? `core-services:${snapshot.resources.core_services.detail}`
    : `resource-warn:${snapshot.readiness_summary.resource_warn_count}`;
  const summaryLine = Object.entries(snapshot.resources)
    .filter(([, item]) => item.status !== 'ok')
    .map(([name, item]) => `${name}: ${item.detail}`)
    .join(' | ') || 'hub readiness healthy';

  if (snapshot.status === 'warn') {
    snapshot.memory_hints = {
      recent_patterns: await buildIssueHints(issueKey, `⚠️ [허브 헬스] readiness 경고\n${summaryLine}`).catch(() => ''),
    };
  }

  if (lastRecordedStatus !== snapshot.status) {
    const kind = snapshot.status === 'warn' ? 'issue' : 'recovery';
    const message = snapshot.status === 'warn'
      ? `⚠️ [허브 헬스] readiness 경고\n${summaryLine}`
      : `✅ [허브 헬스] readiness 회복\n${summaryLine}`;
    void rememberHealthEvent(issueKey, kind, message, snapshot.status === 'warn' ? 2 : 1);
    lastRecordedStatus = snapshot.status;
  }

  return res.status(snapshot.status === 'ok' ? 200 : 503).json({
    ...snapshot,
    ready: snapshot.status === 'ok',
  });
}
