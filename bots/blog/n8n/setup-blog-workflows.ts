// @ts-nocheck
'use strict';
/**
 * bots/blog/n8n/setup-blog-workflows.ts
 *
 * 블로팀 n8n 워크플로우 생성/업데이트 스크립트
 * - "블로그팀 동적 포스팅" 워크플로우를 n8n에 생성
 * - 이미 존재하면 최신 JSON으로 재생성 후 활성화
 *
 * 실행: node bots/blog/n8n/setup-blog-workflows.ts
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');

const EMAIL = process.env.N8N_EMAIL || 'admin@example.com';
const PASSWORD = process.env.N8N_PASSWORD || 'TeamJay2026!';
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';
const WORKFLOW_PATH = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'api', 'n8n-workflow.json');
const parsedBaseUrl = new URL(N8N_BASE_URL);
const client = createN8nSetupClient({
  host: parsedBaseUrl.hostname || '127.0.0.1',
  port: Number(parsedBaseUrl.port || 5678),
  email: EMAIL,
  password: PASSWORD,
  logger: console,
});

async function main() {
  console.log('\n📝 블로팀 n8n 워크플로우 설정 시작\n');
  await client.login();
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  await client.createOrReplaceWorkflow(workflow);
  console.log('\n✅ 블로팀 n8n 워크플로우 설정 완료\n');
}

main().catch((error) => {
  console.error('\n❌ 블로팀 n8n 설정 실패:', error.message);
  process.exit(1);
});
