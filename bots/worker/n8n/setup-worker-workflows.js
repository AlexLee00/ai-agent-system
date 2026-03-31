'use strict';
/**
 * bots/worker/n8n/setup-worker-workflows.js
 *
 * 워커팀 n8n 워크플로우 생성/업데이트 스크립트
 * - "워커팀 자연어 업무 intake" 워크플로우를 n8n에 생성
 * - 이미 존재하면 최신 JSON으로 업데이트 후 활성화
 *
 * 실행: node bots/worker/n8n/setup-worker-workflows.js
 */

const path = require('path');
const fs = require('fs');
const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');

const EMAIL = process.env.N8N_EMAIL || 'admin@example.com';
const PASSWORD = process.env.N8N_PASSWORD || 'TeamJay2026!';
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';
const WORKFLOW_PATH = path.join(__dirname, '../context/n8n-worker-chat-workflow.json');
const SECRETS_PATH = path.join(__dirname, '../secrets.json');
const STORE_PATH = path.join(__dirname, '../../hub/secrets-store.json');
const parsedBaseUrl = new URL(N8N_BASE_URL);
const client = createN8nSetupClient({
  host: parsedBaseUrl.hostname || '127.0.0.1',
  port: Number(parsedBaseUrl.port || 5678),
  email: EMAIL,
  password: PASSWORD,
  logger: console,
});

function loadSecrets() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (raw?.worker) return raw.worker;
  } catch { /* store fallback */ }
  return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
}

function applyWorkerSecrets(workflow, secrets) {
  const cloned = JSON.parse(JSON.stringify(workflow));
  for (const node of cloned.nodes || []) {
    const headers = node.parameters?.headerParameters?.parameters;
    if (!Array.isArray(headers)) continue;
    for (const header of headers) {
      if (header.value === '__WORKER_WEBHOOK_SECRET__') {
        header.value = secrets.worker_webhook_secret || '';
      }
    }
  }
  return cloned;
}

async function main() {
  console.log('\n💼 워커팀 n8n 워크플로우 설정 시작\n');
  await client.login();
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const secrets = loadSecrets();
  const hydratedWorkflow = applyWorkerSecrets(workflow, secrets);
  if (!secrets.worker_webhook_secret) {
    throw new Error('worker_webhook_secret 누락');
  }
  await client.createOrReplaceWorkflow(hydratedWorkflow);
  console.log('\n✅ 워커팀 n8n 워크플로우 설정 완료\n');
}

main().catch((error) => {
  console.error('\n❌ 워커팀 n8n 설정 실패:', error.message);
  process.exit(1);
});
