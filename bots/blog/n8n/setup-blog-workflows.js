'use strict';
/**
 * bots/blog/n8n/setup-blog-workflows.js
 *
 * 블로팀 n8n 워크플로우 생성/업데이트 스크립트
 * - "블로그팀 동적 포스팅" 워크플로우를 n8n에 생성
 * - 이미 존재하면 최신 JSON으로 재생성 후 활성화
 *
 * 실행: node bots/blog/n8n/setup-blog-workflows.js
 */

const path = require('path');
const fs = require('fs');
const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');

const EMAIL = '***REMOVED***';
const PASSWORD = 'TeamJay2026!';
const WORKFLOW_PATH = path.join(__dirname, '../api/n8n-workflow.json');
const client = createN8nSetupClient({ email: EMAIL, password: PASSWORD, logger: console });

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
