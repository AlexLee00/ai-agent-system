import http from 'node:http';

type LoggerLike = Pick<Console, 'log'>;

type RequestResponse = {
  status: number | undefined;
  body: unknown;
};

type WorkflowSummary = {
  id?: string;
  name?: string;
};

type WorkflowDetail = {
  id?: string;
  versionId?: string;
  [key: string]: unknown;
};

type CredentialSummary = {
  id?: string;
  name?: string;
};

type CreateN8nSetupClientArgs = {
  host?: string;
  port?: number;
  email?: string;
  password?: string;
  logger?: LoggerLike;
};

type N8nWorkflowPayload = {
  name: string;
  [key: string]: unknown;
};

function getBodyData<T>(body: unknown): T | undefined {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data?: T }).data;
  }
  return body as T | undefined;
}

export function createN8nSetupClient({
  host = 'localhost',
  port = 5678,
  email,
  password,
  logger = console,
}: CreateN8nSetupClientArgs = {}) {
  let cookie = '';

  function request(method: string, urlPath: string, body?: unknown): Promise<RequestResponse> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: host,
          port,
          path: urlPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            cookie = setCookie.map((item) => item.split(';')[0]).join('; ');
          }
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) as unknown });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function login(): Promise<void> {
    const res = await request('POST', '/rest/login', {
      emailOrLdapLoginId: email,
      password,
    });
    if (res.status !== 200) {
      throw new Error(`n8n 로그인 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log('  ✅ n8n 로그인 성공');
  }

  async function listWorkflows(): Promise<WorkflowSummary[]> {
    const res = await request('GET', '/rest/workflows');
    if (res.status !== 200) {
      throw new Error(`워크플로우 목록 조회 실패: ${JSON.stringify(res.body)}`);
    }
    return getBodyData<WorkflowSummary[]>(res.body) || [];
  }

  async function getWorkflow(id: string): Promise<WorkflowDetail> {
    const res = await request('GET', `/rest/workflows/${id}`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 조회 실패: ${JSON.stringify(res.body)}`);
    }
    return getBodyData<WorkflowDetail>(res.body) || {};
  }

  async function activateWorkflow(id: string, versionId: string | undefined, name: string): Promise<void> {
    const res = await request('POST', `/rest/workflows/${id}/activate`, { versionId });
    const data = getBodyData<{ active?: boolean }>(res.body);
    if (data?.active) {
      logger.log(`  ✅ 워크플로우 활성화: "${name}"`);
      return;
    }
    logger.log(`  ⚠️ 활성화 응답 확인 필요: "${name}"`);
  }

  async function deactivateWorkflow(id: string, name: string): Promise<void> {
    const res = await request('POST', `/rest/workflows/${id}/deactivate`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 비활성화 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  ⏸️ 워크플로우 비활성화: "${name}" (id: ${id})`);
  }

  async function archiveWorkflow(id: string, name: string): Promise<void> {
    const res = await request('POST', `/rest/workflows/${id}/archive`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 아카이브 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  📦 워크플로우 아카이브: "${name}" (id: ${id})`);
  }

  async function deleteWorkflow(id: string, name: string): Promise<void> {
    const res = await request('DELETE', `/rest/workflows/${id}`);
    if (res.status !== 200) {
      throw new Error(`워크플로우 삭제 실패: ${JSON.stringify(res.body)}`);
    }
    logger.log(`  🗑️ 기존 워크플로우 삭제: "${name}" (id: ${id})`);
  }

  async function createOrReplaceWorkflow(workflow: N8nWorkflowPayload): Promise<WorkflowDetail> {
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
    const createdData = getBodyData<WorkflowDetail>(created.body) || {};
    logger.log(`  ✅ 워크플로우 생성: "${workflow.name}" (id: ${createdData.id})`);
    if (!createdData.id) {
      return createdData;
    }
    const detail = await getWorkflow(createdData.id);
    await activateWorkflow(createdData.id, detail.versionId, workflow.name);
    return createdData;
  }

  async function listCredentials(): Promise<CredentialSummary[]> {
    const res = await request('GET', '/rest/credentials');
    if (res.status !== 200) {
      throw new Error(`자격증명 목록 조회 실패: ${JSON.stringify(res.body)}`);
    }
    return getBodyData<CredentialSummary[]>(res.body) || [];
  }

  async function getCredentialId(name: string): Promise<string | undefined> {
    const found = (await listCredentials()).find((item) => item.name === name);
    if (!found) {
      throw new Error(`자격증명 "${name}" 없음`);
    }
    logger.log(`  ✅ 자격증명 "${name}" (id: ${found.id})`);
    return found.id;
  }

  async function createCredential(name: string, type: string, data: unknown): Promise<string | undefined> {
    const existing = (await listCredentials()).find((item) => item.name === name);
    if (existing) {
      logger.log(`  ⏭️  자격증명 "${name}" 이미 존재 — 스킵`);
      return existing.id;
    }

    const res = await request('POST', '/rest/credentials', { name, type, data });
    if (res.status !== 200) {
      throw new Error(`자격증명 생성 실패: ${JSON.stringify(res.body)}`);
    }
    const createdData = getBodyData<{ id?: string }>(res.body);
    logger.log(`  ✅ 자격증명 생성: "${name}" (id: ${createdData?.id})`);
    return createdData?.id;
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
