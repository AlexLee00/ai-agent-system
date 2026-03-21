'use strict';

const fs = require('fs');
const path = require('path');

const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { resolveVideoN8nToken } = require('../lib/video-n8n-config');

const WORKFLOW_PATH = path.join(__dirname, 'video-pipeline-workflow.json');
const EMAIL = process.env.N8N_EMAIL || '***REMOVED***';
const PASSWORD = process.env.N8N_PASSWORD || 'TeamJay2026!';
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';
const VIDEO_TOKEN = resolveVideoN8nToken();
const INTERNAL_API_BASE_URL = process.env.WORKER_API_INTERNAL_URL || 'http://127.0.0.1:4000';
const parsedBaseUrl = new URL(N8N_BASE_URL);

const client = createN8nSetupClient({
  host: parsedBaseUrl.hostname || '127.0.0.1',
  port: Number(parsedBaseUrl.port || 5678),
  email: EMAIL,
  password: PASSWORD,
  logger: console,
});

function hydrateWorkflow(workflow) {
  if (!VIDEO_TOKEN) {
    throw new Error('VIDEO_N8N_TOKEN 환경변수가 필요합니다.');
  }

  const cloned = JSON.parse(JSON.stringify(workflow));
  for (const node of cloned.nodes || []) {
    if (node.type === 'n8n-nodes-base.code' && typeof node.parameters?.jsCode === 'string') {
      node.parameters.jsCode = node.parameters.jsCode.replace(/__VIDEO_N8N_TOKEN__/g, VIDEO_TOKEN);
    }
    if (typeof node.parameters?.url === 'string') {
      node.parameters.url = node.parameters.url
        .replace(/__VIDEO_INTERNAL_API_BASE_URL__/g, INTERNAL_API_BASE_URL)
        .replace(/__VIDEO_N8N_TOKEN__/g, VIDEO_TOKEN);
    }
    const headers = node.parameters?.headerParameters?.parameters;
    if (Array.isArray(headers)) {
      for (const header of headers) {
        if (header.value === '__VIDEO_N8N_TOKEN__') {
          header.value = VIDEO_TOKEN;
        }
      }
    }
  }
  return cloned;
}

async function main() {
  console.log('\n🎬 비디오팀 n8n 워크플로우 설정 시작\n');
  await client.login();

  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const hydrated = hydrateWorkflow(workflow);
  const created = await client.createOrReplaceWorkflow(hydrated);

  let resolvedWebhookUrl = null;
  let resolveError = null;
  try {
    resolvedWebhookUrl = await resolveProductionWebhookUrl({
      workflowName: workflow.name,
      method: 'POST',
      pathSuffix: 'video-pipeline',
      baseUrl: N8N_BASE_URL,
    });
  } catch (error) {
    resolveError = error?.message || String(error);
  }
  const defaultWebhookUrl = `${String(N8N_BASE_URL).replace(/\/+$/, '')}/webhook/video-pipeline`;

  console.log(`  ✅ 워크플로우 확인: "${workflow.name}" (id: ${created?.id || 'unknown'})`);
  if (resolveError) {
    console.log(`  ⚠️ webhook registry 조회 실패 — 기본 경로 사용 (${resolveError})`);
  }
  console.log(`  🔗 webhook: ${resolvedWebhookUrl || defaultWebhookUrl}`);
  console.log('\n✅ 비디오팀 n8n 워크플로우 설정 완료\n');
}

main().catch((error) => {
  console.error('\n❌ 비디오팀 n8n 설정 실패:', error.message);
  process.exit(1);
});
