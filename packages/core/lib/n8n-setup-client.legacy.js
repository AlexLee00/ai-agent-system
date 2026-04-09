'use strict';

const http = require('http');

function createN8nSetupClient({
  host = 'localhost',
  port = 5678,
  email,
  password,
  logger = console,
} = {}) {
  let cookie = '';

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: host,
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, (res) => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          cookie = setCookie.map((item) => item.split(';')[0]).join('; ');
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
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
      emailOrLdapLoginId: email,
      password,
    });
    if (res.status !== 200) {
      throw new Error(`n8n 로그인 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log('  ✅ n8n 로그인 성공');
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
      logger.log(`  ✅ 워크플로우 활성화: "${name}"`);
      return;
    }
    logger.log(`  ⚠️ 활성화 응답 확인 필요: "${name}"`);
  }

  async function deactivateWorkflow(id, name) {
    const res = await request('POST', `/rest/workflows/${id}/deactivate`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 비활성화 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  ⏸️ 워크플로우 비활성화: "${name}" (id: ${id})`);
  }

  async function archiveWorkflow(id, name) {
    const res = await request('POST', `/rest/workflows/${id}/archive`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 아카이브 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  📦 워크플로우 아카이브: "${name}" (id: ${id})`);
  }

  async function deleteWorkflow(id, name) {
    const res = await request('DELETE', `/rest/workflows/${id}`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 삭제 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  🗑️ 기존 워크플로우 삭제: "${name}" (id: ${id})`);
  }

  async function createOrReplaceWorkflow(workflow) {
    const existing = (await listWorkflows()).find((item) => item.name === workflow.name);

    if (existing?.id) {
      await deactivateWorkflow(existing.id, workflow.name);
      await archiveWorkflow(existing.id, workflow.name);
      await deleteWorkflow(existing.id, workflow.name);
    }

    const created = await request('POST', '/rest/workflows', workflow);
    if (created.status !== 200) {
      throw new Error(`워크플로우 생성 실패: ${JSON.stringify(created.body)}`);
    }
    const createdData = created.body?.data || created.body;
    logger.log(`  ✅ 워크플로우 생성: "${workflow.name}" (id: ${createdData?.id})`);
    const detail = await getWorkflow(createdData.id);
    await activateWorkflow(createdData.id, detail.versionId, workflow.name);
    return createdData;
  }

  async function listCredentials() {
    const res = await request('GET', '/rest/credentials');
    if (res.status !== 200) {
      throw new Error(`자격증명 목록 조회 실패: ${JSON.stringify(res.body)}`);
    }
    return res.body?.data || [];
  }

  async function getCredentialId(name) {
    const found = (await listCredentials()).find((item) => item.name === name);
    if (!found) {
      throw new Error(`자격증명 "${name}" 없음`);
    }
    logger.log(`  ✅ 자격증명 "${name}" (id: ${found.id})`);
    return found.id;
  }

  async function createCredential(name, type, data) {
    const existing = (await listCredentials()).find((item) => item.name === name);
    if (existing) {
      logger.log(`  ⏭️  자격증명 "${name}" 이미 존재 — 스킵`);
      return existing.id;
    }

    const res = await request('POST', '/rest/credentials', { name, type, data });
    if (res.status !== 200) {
      throw new Error(`자격증명 생성 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  ✅ 자격증명 생성: "${name}" (id: ${res.body.data?.id})`);
    return res.body.data?.id;
  }

  return {
    request,
    login,
    listWorkflows,
    getWorkflow,
    createOrReplaceWorkflow,
    listCredentials,
    getCredentialId,
    createCredential,
  };
}

module.exports = {
  createN8nSetupClient,
};
