import * as pgPool from './pg-pool';
import { N8N_BASE_URL as DEFAULT_N8N_BASE, N8N_ENABLED } from './env';

type WebhookCandidateInput = {
  workflowName?: string;
  method?: string;
  pathSuffix?: string;
  baseUrl?: string;
  configured?: string[] | string;
  defaults?: string[] | string;
};

type WebhookRow = {
  webhookPath?: string | null;
};

function normalizeList(value?: string[] | string): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

export async function resolveProductionWebhookUrl({
  workflowName,
  method = 'POST',
  pathSuffix = '',
  baseUrl = DEFAULT_N8N_BASE,
}: WebhookCandidateInput = {}): Promise<string | null> {
  if (!N8N_ENABLED) return null;
  if (!workflowName) return null;

  const rows = (await pgPool.query(
    'public',
    `
    SELECT we."webhookPath" AS "webhookPath"
    FROM n8n.webhook_entity we
    JOIN n8n.workflow_entity wf ON wf.id = we."workflowId"
    WHERE wf.name = $1
      AND we.method = $2
      AND ($3 = '' OR we."webhookPath" LIKE $3)
    LIMIT 5
  `,
    [workflowName, method, pathSuffix ? `%${pathSuffix}` : ''],
  )) as WebhookRow[];

  const row = rows.find((item) => item?.webhookPath) || null;
  if (!row?.webhookPath) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/webhook/${String(row.webhookPath).replace(/^\/+/, '')}`;
}

export async function buildWebhookCandidates({
  workflowName,
  method = 'POST',
  pathSuffix = '',
  configured = [],
  defaults = [],
}: WebhookCandidateInput = {}): Promise<string[]> {
  let resolved: string | null = null;
  try {
    resolved = await resolveProductionWebhookUrl({
      workflowName,
      method,
      pathSuffix,
    });
  } catch {
    resolved = null;
  }

  return [...new Set([...normalizeList(configured), resolved, ...normalizeList(defaults)].filter(Boolean))] as string[];
}
