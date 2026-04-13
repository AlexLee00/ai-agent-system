'use strict';
/**
 * bots/reservation/n8n/setup-ska-command-workflow.ts
 *
 * 스카팀 읽기 명령 webhook 워크플로우 생성/업데이트 스크립트
 * - query_reservations
 * - query_today_stats
 * - query_alerts
 *
 * 실행: node dist/ts-runtime/bots/reservation/n8n/setup-ska-command-workflow.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const EMAIL = process.env.N8N_EMAIL || 'admin@example.com';
const PASSWORD = process.env.N8N_PASSWORD || 'TeamJay2026!';
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';
const parsedBaseUrl = new URL(N8N_BASE_URL);
const WORKFLOW_PATH = path.join(__dirname, '../context/n8n-ska-command-workflow.json');
const SECRETS_PATH = path.join(__dirname, '../secrets.json');
const STORE_PATH = path.join(__dirname, '../../hub/secrets-store.json');

let cookie = '';

type RequestResult<T = unknown> = {
  status: number | undefined;
  body: T;
};

type WorkflowNode = {
  credentials?: {
    postgres?: {
      id?: string;
    };
  };
  parameters?: {
    headerParameters?: {
      parameters?: Array<{
        value?: string;
      }>;
    };
  };
};

type WorkflowDefinition = {
  id?: string;
  name: string;
  versionId?: string;
  nodes?: WorkflowNode[];
};

type WorkflowListItem = {
  id: string;
  name: string;
};

type CredentialListItem = {
  id: string;
  name: string;
};

function resolveWorkflowResponseBody(body: WorkflowDefinition | { data?: WorkflowDefinition }): WorkflowDefinition {
  if ('name' in body) return body;
  if (body.data) return body.data;
  throw new Error('워크플로우 응답에 data가 없습니다.');
}

function loadSecrets() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (raw?.reservation) return raw.reservation;
  } catch {
    // fallback to local secrets.json
  }
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function request<T = unknown>(method: string, urlPath: string, body?: unknown): Promise<RequestResult<T>> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: parsedBaseUrl.hostname || '127.0.0.1',
      port: Number(parsedBaseUrl.port || 5678),
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) cookie = setCookie.map((item: string) => item.split(';')[0]).join('; ');
      let data = '';
      res.on('data', (chunk: Buffer | string) => { data += String(chunk); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) as T });
        } catch {
          resolve({ status: res.statusCode, body: data as T });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login() {
  const res = await request('POST', '/rest/login', {
    emailOrLdapLoginId: EMAIL,
    password: PASSWORD,
  });
  if (res.status !== 200) {
    throw new Error(`n8n 로그인 실패: ${JSON.stringify(res.body)}`);
  }
  console.log('  ✅ n8n 로그인 성공');
}

async function listWorkflows() {
  const res = await request<{ data?: WorkflowListItem[] }>('GET', '/rest/workflows');
  if (res.status !== 200) throw new Error(`워크플로우 목록 조회 실패: ${JSON.stringify(res.body)}`);
  return res.body?.data || [];
}

async function getWorkflow(id: string): Promise<WorkflowDefinition> {
  const res = await request<{ data?: WorkflowDefinition }>('GET', `/rest/workflows/${id}`);
  if (res.status !== 200) throw new Error(`워크플로우 조회 실패: ${JSON.stringify(res.body)}`);
  return resolveWorkflowResponseBody(res.body);
}

async function getCredentialId(name) {
  const res = await request<{ data?: CredentialListItem[] }>('GET', '/rest/credentials');
  const found = res.body?.data?.find((item) => item.name === name);
  if (!found) throw new Error(`자격증명 "${name}" 없음`);
  console.log(`  ✅ 자격증명 "${name}" (id: ${found.id})`);
  return found.id;
}

function applyCredentialIds(workflow: WorkflowDefinition, postgresCredentialId: string): WorkflowDefinition {
  const cloned = JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
  const secrets = loadSecrets();
  const webhookSecret = process.env.SKA_WEBHOOK_SECRET || secrets.ska_webhook_secret || '';
  for (const node of cloned.nodes || []) {
    if (node.credentials?.postgres?.id === '__POSTGRES_CREDENTIAL_ID__') {
      node.credentials.postgres.id = postgresCredentialId;
    }
    const headers = node.parameters?.headerParameters?.parameters;
    if (Array.isArray(headers)) {
      for (const header of headers) {
        if (header.value === '__SKA_WEBHOOK_SECRET__') {
          header.value = webhookSecret;
        }
      }
    }
  }
  return cloned;
}

async function activateWorkflow(id: string, versionId: string | undefined, name: string) {
  const res = await request<{ data?: { active?: boolean } }>('POST', `/rest/workflows/${id}/activate`, { versionId });
  if (res.body?.data?.active) {
    console.log(`  ✅ 워크플로우 활성화: "${name}"`);
    return;
  }
  console.log(`  ⚠️ 활성화 응답 확인 필요: "${name}"`);
}

async function deactivateWorkflow(id: string, name: string) {
  const res = await request('POST', `/rest/workflows/${id}/deactivate`);
  if (res.status !== 200) throw new Error(`워크플로우 비활성화 실패: ${JSON.stringify(res.body)}`);
  console.log(`  ⏸️ 워크플로우 비활성화: "${name}" (id: ${id})`);
}

async function archiveWorkflow(id: string, name: string) {
  const res = await request('POST', `/rest/workflows/${id}/archive`);
  if (res.status !== 200) throw new Error(`워크플로우 아카이브 실패: ${JSON.stringify(res.body)}`);
  console.log(`  📦 워크플로우 아카이브: "${name}" (id: ${id})`);
}

async function deleteWorkflow(id: string, name: string) {
  const res = await request('DELETE', `/rest/workflows/${id}`);
  if (res.status !== 200) throw new Error(`워크플로우 삭제 실패: ${JSON.stringify(res.body)}`);
  console.log(`  🗑️ 기존 워크플로우 삭제: "${name}" (id: ${id})`);
}

async function createOrUpdateWorkflow(workflow: WorkflowDefinition) {
  const existing = (await listWorkflows()).find((item) => item.name === workflow.name);

  if (!existing) {
    const created = await request<{ data?: WorkflowDefinition }>('POST', '/rest/workflows', workflow);
    if (created.status !== 200) {
      throw new Error(`워크플로우 생성 실패: ${JSON.stringify(created.body)}`);
    }
    const createdData = resolveWorkflowResponseBody(created.body);
    console.log(`  ✅ 워크플로우 생성: "${workflow.name}" (id: ${createdData?.id})`);
    const detail = await getWorkflow(createdData.id);
    await activateWorkflow(createdData.id, detail.versionId, workflow.name);
    return;
  }

  await deactivateWorkflow(existing.id, workflow.name);
  await archiveWorkflow(existing.id, workflow.name);
  await deleteWorkflow(existing.id, workflow.name);

  const created = await request<{ data?: WorkflowDefinition }>('POST', '/rest/workflows', workflow);
  if (created.status !== 200) {
    throw new Error(`워크플로우 재생성 실패: ${JSON.stringify(created.body)}`);
  }
  const createdData = resolveWorkflowResponseBody(created.body);
  console.log(`  ✅ 워크플로우 재생성: "${workflow.name}" (id: ${createdData?.id})`);
  const detail = await getWorkflow(createdData.id);
  await activateWorkflow(createdData.id, detail.versionId, workflow.name);
}

async function main() {
  console.log('\n🏢 스카팀 읽기 명령 n8n 워크플로우 설정 시작\n');
  await login();
  const postgresCredentialId = await getCredentialId('Team Jay PostgreSQL');
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowDefinition;
  const hydrated = applyCredentialIds(workflow, postgresCredentialId);
  await createOrUpdateWorkflow(hydrated);
  console.log('\n✅ 스카팀 읽기 명령 n8n 워크플로우 설정 완료\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n❌ 스카팀 읽기 명령 n8n 설정 실패:', message);
  process.exit(1);
});
