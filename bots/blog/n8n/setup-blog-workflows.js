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

const http = require('http');
const path = require('path');
const fs = require('fs');

const EMAIL = '***REMOVED***';
const PASSWORD = 'TeamJay2026!';
const WORKFLOW_PATH = path.join(__dirname, '../api/n8n-workflow.json');

let cookie = '';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: 5678,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) cookie = setCookie.map(item => item.split(';')[0]).join('; ');
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
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
  const res = await request('GET', '/rest/workflows');
  if (res.status !== 200) {
    throw new Error(`워크플로우 목록 조회 실패: ${JSON.stringify(res.body)}`);
  }
  return res.body?.data || [];
}

async function getWorkflow(id) {
  const res = await request('GET', `/rest/workflows/${id}`);
  if (res.status !== 200) {
    throw new Error(`워크플로우 조회 실패: ${JSON.stringify(res.body)}`);
  }
  return res.body?.data || res.body;
}

async function activateWorkflow(id, versionId, name) {
  const res = await request('POST', `/rest/workflows/${id}/activate`, { versionId });
  if (res.body?.data?.active) {
    console.log(`  ✅ 워크플로우 활성화: "${name}"`);
    return;
  }
  console.log(`  ⚠️ 활성화 응답 확인 필요: "${name}"`);
}

async function deactivateWorkflow(id, name) {
  const res = await request('POST', `/rest/workflows/${id}/deactivate`);
  if (res.status !== 200) {
    throw new Error(`워크플로우 비활성화 실패: ${JSON.stringify(res.body)}`);
  }
  console.log(`  ⏸️ 워크플로우 비활성화: "${name}" (id: ${id})`);
}

async function archiveWorkflow(id, name) {
  const res = await request('POST', `/rest/workflows/${id}/archive`);
  if (res.status !== 200) {
    throw new Error(`워크플로우 아카이브 실패: ${JSON.stringify(res.body)}`);
  }
  console.log(`  📦 워크플로우 아카이브: "${name}" (id: ${id})`);
}

async function deleteWorkflow(id, name) {
  const res = await request('DELETE', `/rest/workflows/${id}`);
  if (res.status !== 200) {
    throw new Error(`워크플로우 삭제 실패: ${JSON.stringify(res.body)}`);
  }
  console.log(`  🗑️ 기존 워크플로우 삭제: "${name}" (id: ${id})`);
}

async function createOrUpdateWorkflow(workflow) {
  const existing = (await listWorkflows()).find(item => item.name === workflow.name);

  if (!existing) {
    const created = await request('POST', '/rest/workflows', workflow);
    if (created.status !== 200) {
      throw new Error(`워크플로우 생성 실패: ${JSON.stringify(created.body)}`);
    }
    const createdData = created.body?.data || created.body;
    console.log(`  ✅ 워크플로우 생성: "${workflow.name}" (id: ${createdData?.id})`);
    const detail = await getWorkflow(createdData.id);
    await activateWorkflow(createdData.id, detail.versionId, workflow.name);
    return;
  }

  await deactivateWorkflow(existing.id, workflow.name);
  await archiveWorkflow(existing.id, workflow.name);
  await deleteWorkflow(existing.id, workflow.name);

  const created = await request('POST', '/rest/workflows', workflow);
  if (created.status !== 200) {
    throw new Error(`워크플로우 재생성 실패: ${JSON.stringify(created.body)}`);
  }
  const createdData = created.body?.data || created.body;
  console.log(`  ✅ 워크플로우 재생성: "${workflow.name}" (id: ${createdData?.id})`);
  const detail = await getWorkflow(createdData.id);
  await activateWorkflow(createdData.id, detail.versionId, workflow.name);
}

async function main() {
  console.log('\n📝 블로팀 n8n 워크플로우 설정 시작\n');
  await login();
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  await createOrUpdateWorkflow(workflow);
  console.log('\n✅ 블로팀 n8n 워크플로우 설정 완료\n');
}

main().catch((error) => {
  console.error('\n❌ 블로팀 n8n 설정 실패:', error.message);
  process.exit(1);
});
