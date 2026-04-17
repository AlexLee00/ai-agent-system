// @ts-nocheck
'use strict';

/**
 * bots/hub/scripts/create-n8n-phase5-workflows.ts
 * n8n Phase 5 Step 3~4 워크플로우 생성
 *
 * Step 3: RAG 인제스트 워크플로우 (2개)
 *   - rag-ingest: 웹훅 기반 단건 RAG 저장
 *   - rag-daily-ingest: 스케줄 기반 일일 이벤트 배치 RAG 저장
 *
 * Step 4: 마케팅 워크플로우
 *   - blog-marketing: 블로그 발행 → 인스타 크로스포스트 → 성과 기록
 *
 * 실행: npx tsx bots/hub/scripts/create-n8n-phase5-workflows.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const env = require('../../../packages/core/lib/env');

const N8N_BASE_URL = env.N8N_BASE_URL || 'http://127.0.0.1:5678';

function getN8nApiKey(): string {
  if (env.N8N_API_KEY) return env.N8N_API_KEY;
  try {
    const storePath = path.join(env.PROJECT_ROOT || '', 'bots/hub/secrets-store.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return store?.n8n_api_key || '';
  } catch {
    return '';
  }
}

async function n8nRequest(method: string, apiPath: string, body?: unknown) {
  const apiKey = getN8nApiKey();
  if (!apiKey) throw new Error('n8n API key missing');
  const resp = await fetch(`${N8N_BASE_URL}/api/v1${apiPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`n8n API ${method} ${apiPath} → ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function workflowExists(name: string): Promise<string | null> {
  const data = await n8nRequest('GET', '/workflows?limit=100') as any;
  const found = (data.data || []).find((w: any) => w.name === name);
  return found?.id || null;
}

// ─── Step 3-A: RAG 웹훅 인제스트 워크플로우 ─────────────────────────────────

const RAG_INGEST_WORKFLOW = {
  name: 'RAG 인제스트 (웹훅)',
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'rag-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 300],
      parameters: {
        path: 'rag-ingest',
        httpMethod: 'POST',
        responseMode: 'responseNode',
      },
    },
    {
      id: 'rag-parse',
      name: '입력 검증',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [460, 300],
      parameters: {
        jsCode: `
const body = $input.item.json.body || $input.item.json;
const { agentId, team, content, type, keywords, importance, metadata } = body;

if (!agentId || !team || !content) {
  throw new Error('agentId, team, content 필수');
}

return [{
  json: {
    agentId: String(agentId),
    team: String(team),
    content: String(content).slice(0, 8000),
    type: type || 'episodic',
    keywords: Array.isArray(keywords) ? keywords : [],
    importance: typeof importance === 'number' ? importance : 0.5,
    metadata: metadata || {},
  }
}];
`.trim(),
      },
    },
    {
      id: 'rag-store',
      name: 'Hub 메모리 저장',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [680, 300],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/memory/remember',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        bodyParameters: {
          parameters: [
            { name: 'agentId', value: '={{ $json.agentId }}' },
            { name: 'team', value: '={{ $json.team }}' },
            { name: 'content', value: '={{ $json.content }}' },
            { name: 'type', value: '={{ $json.type }}' },
            { name: 'importance', value: '={{ $json.importance }}' },
          ],
        },
        options: { timeout: 30000 },
      },
    },
    {
      id: 'rag-respond',
      name: '완료 응답',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [900, 300],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ { ok: true, memoryId: $json.memoryId } }}',
      },
    },
  ],
  connections: {
    'Webhook': { main: [[{ node: '입력 검증', type: 'main', index: 0 }]] },
    '입력 검증': { main: [[{ node: 'Hub 메모리 저장', type: 'main', index: 0 }]] },
    'Hub 메모리 저장': { main: [[{ node: '완료 응답', type: 'main', index: 0 }]] },
  },
};

// ─── Step 3-B: RAG 일일 배치 인제스트 워크플로우 ─────────────────────────────

const RAG_DAILY_WORKFLOW = {
  name: 'RAG 일일 배치 인제스트',
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'daily-schedule',
      name: '매일 03:00',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1,
      position: [240, 300],
      parameters: {
        rule: { interval: [{ field: 'cronExpression', expression: '0 18 * * *' }] },
      },
    },
    {
      id: 'fetch-events',
      name: '24h 이벤트 수집',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [460, 300],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/pg/query',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: JSON.stringify({
          sql: `SELECT team, event_type, title, message, created_at
                FROM agent.event_lake
                WHERE created_at > NOW() - INTERVAL '24 hours'
                  AND alert_level >= 2
                ORDER BY alert_level DESC, created_at DESC
                LIMIT 50`,
          schema: 'agent',
        }),
        options: { timeout: 15000 },
      },
    },
    {
      id: 'prepare-rag',
      name: 'RAG 콘텐츠 변환',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [680, 300],
      parameters: {
        jsCode: `
const rows = $input.item.json.rows || [];
if (!rows.length) {
  return [{ json: { skipped: true, reason: '24h 이벤트 없음' } }];
}

// 팀별로 그룹화
const byTeam = {};
for (const row of rows) {
  const team = row.team || 'system';
  if (!byTeam[team]) byTeam[team] = [];
  byTeam[team].push(row);
}

const results = [];
for (const [team, events] of Object.entries(byTeam)) {
  const content = [
    \`[${new Date().toISOString().slice(0,10)} 일일 이벤트 요약 — \${team}팀]\`,
    ...events.map(e => \`• [\${e.event_type}] \${e.title || ''}: \${(e.message||'').slice(0,100)}\`),
  ].join('\\n');

  results.push({
    json: {
      agentId: \`\${team}-daily-summary\`,
      team,
      content: content.slice(0, 4000),
      type: 'episodic',
      importance: 0.6,
    }
  });
}
return results;
`.trim(),
      },
    },
    {
      id: 'store-rag',
      name: 'RAG 저장 (팀별)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [900, 300],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/memory/remember',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        bodyParameters: {
          parameters: [
            { name: 'agentId', value: '={{ $json.agentId }}' },
            { name: 'team', value: '={{ $json.team }}' },
            { name: 'content', value: '={{ $json.content }}' },
            { name: 'type', value: '={{ $json.type }}' },
            { name: 'importance', value: '={{ $json.importance }}' },
          ],
        },
        options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 500 } } },
      },
    },
    {
      id: 'notify-complete',
      name: '완료 알림',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [1120, 300],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/n8n/webhook/critical-alert-escalation',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: JSON.stringify({
          from_bot: 'rag-daily-ingest',
          team: 'system',
          event_type: 'rag_daily_ingest_complete',
          alert_level: 1,
          message: 'RAG 일일 배치 인제스트 완료',
        }),
        options: { timeout: 10000 },
      },
    },
  ],
  connections: {
    '매일 03:00': { main: [[{ node: '24h 이벤트 수집', type: 'main', index: 0 }]] },
    '24h 이벤트 수집': { main: [[{ node: 'RAG 콘텐츠 변환', type: 'main', index: 0 }]] },
    'RAG 콘텐츠 변환': { main: [[{ node: 'RAG 저장 (팀별)', type: 'main', index: 0 }]] },
    'RAG 저장 (팀별)': { main: [[{ node: '완료 알림', type: 'main', index: 0 }]] },
  },
};

// ─── Step 4: 마케팅 워크플로우 ───────────────────────────────────────────────

const MARKETING_WORKFLOW = {
  name: '블로그 마케팅 파이프라인',
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'marketing-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 300],
      parameters: {
        path: 'blog-marketing',
        httpMethod: 'POST',
        responseMode: 'responseNode',
      },
    },
    {
      id: 'parse-post',
      name: '포스트 파싱',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [460, 300],
      parameters: {
        jsCode: `
const body = $input.item.json.body || $input.item.json;
const {
  postId, postTitle, publishedUrl, category,
  imagePath, thumbnailUrl,
  team, source,
} = body;

if (!postId || !publishedUrl) {
  throw new Error('postId, publishedUrl 필수');
}

const hasMedia = !!(imagePath || thumbnailUrl);

return [{
  json: {
    postId: String(postId),
    postTitle: String(postTitle || ''),
    publishedUrl: String(publishedUrl),
    category: String(category || '일반'),
    imagePath: imagePath || null,
    thumbnailUrl: thumbnailUrl || null,
    hasMedia,
    team: String(team || 'blog'),
    source: String(source || 'blog'),
    timestamp: new Date().toISOString(),
  }
}];
`.trim(),
      },
    },
    {
      id: 'check-media',
      name: '이미지 있음?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [680, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              leftValue: '={{ $json.hasMedia }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'true' },
            },
          ],
          combinator: 'and',
        },
      },
    },
    {
      id: 'insta-crosspost',
      name: '인스타 크로스포스트',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [900, 200],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/n8n/webhook/blog-insta-crosspost',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        bodyParameters: {
          parameters: [
            { name: 'postId', value: '={{ $json.postId }}' },
            { name: 'postTitle', value: '={{ $json.postTitle }}' },
            { name: 'publishedUrl', value: '={{ $json.publishedUrl }}' },
            { name: 'imagePath', value: '={{ $json.imagePath }}' },
            { name: 'thumbnailUrl', value: '={{ $json.thumbnailUrl }}' },
            { name: 'category', value: '={{ $json.category }}' },
          ],
        },
        options: { timeout: 30000 },
      },
    },
    {
      id: 'no-media-log',
      name: '이미지 없음 (텍스트 전용)',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [900, 420],
      parameters: {
        jsCode: `
return [{
  json: {
    ...$input.item.json,
    crosspostSkipped: true,
    skipReason: '이미지/영상 없음 — 텍스트 전용 포스트',
  }
}];
`.trim(),
      },
    },
    {
      id: 'record-result',
      name: '성과 기록',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [1120, 300],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/pg/query',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `{{ JSON.stringify({
          sql: \`INSERT INTO blog.instagram_crosspost
                  (post_id, post_title, status, created_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT DO NOTHING\`,
          params: [$json.postId, $json.postTitle, $json.crosspostSkipped ? 'skipped' : 'initiated'],
          schema: 'blog'
        }) }}`,
        options: { timeout: 10000 },
      },
    },
    {
      id: 'rag-store-marketing',
      name: 'RAG 마케팅 기록',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [1120, 160],
      parameters: {
        method: 'POST',
        url: 'http://127.0.0.1:7788/hub/memory/remember',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.HUB_AUTH_TOKEN ? "Bearer " + $env.HUB_AUTH_TOKEN : "" }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `{{ JSON.stringify({
          agentId: 'blog-marketing',
          team: 'blog',
          content: \`블로그 발행 마케팅: [$json.postTitle] ($json.publishedUrl) — 인스타 \${$json.crosspostSkipped ? '건너뜀' : '진행'}\`,
          type: 'episodic',
          importance: 0.4,
        }) }}`,
        options: { timeout: 15000 },
      },
    },
    {
      id: 'marketing-respond',
      name: '완료 응답',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [1340, 300],
      parameters: {
        respondWith: 'json',
        responseBody: `={{ { ok: true, postId: $json.postId, crosspostInitiated: !$json.crosspostSkipped } }}`,
      },
    },
  ],
  connections: {
    'Webhook': { main: [[{ node: '포스트 파싱', type: 'main', index: 0 }]] },
    '포스트 파싱': { main: [[{ node: '이미지 있음?', type: 'main', index: 0 }]] },
    '이미지 있음?': {
      main: [
        [{ node: '인스타 크로스포스트', type: 'main', index: 0 }],
        [{ node: '이미지 없음 (텍스트 전용)', type: 'main', index: 0 }],
      ],
    },
    '인스타 크로스포스트': {
      main: [
        [{ node: 'RAG 마케팅 기록', type: 'main', index: 0 }],
        [{ node: '성과 기록', type: 'main', index: 0 }],
      ],
    },
    '이미지 없음 (텍스트 전용)': { main: [[{ node: '성과 기록', type: 'main', index: 0 }]] },
    'RAG 마케팅 기록': { main: [[{ node: '완료 응답', type: 'main', index: 0 }]] },
    '성과 기록': { main: [[{ node: '완료 응답', type: 'main', index: 0 }]] },
  },
};

// ─── 메인: 생성 실행 ─────────────────────────────────────────────────────────

async function createOrUpdate(workflow: typeof RAG_INGEST_WORKFLOW) {
  const existingId = await workflowExists(workflow.name);
  if (existingId) {
    console.log(`  ↻ 업데이트: "${workflow.name}" (id: ${existingId})`);
    const result = await n8nRequest('PUT', `/workflows/${existingId}`, workflow) as any;
    return result;
  } else {
    console.log(`  + 생성: "${workflow.name}"`);
    const result = await n8nRequest('POST', '/workflows', workflow) as any;
    // 활성화
    await n8nRequest('POST', `/workflows/${result.id}/activate`);
    return result;
  }
}

async function main() {
  console.log('[n8n Phase 5] Step 3~4 워크플로우 생성 시작\n');

  const workflows = [
    { label: 'Step 3-A: RAG 웹훅 인제스트', wf: RAG_INGEST_WORKFLOW },
    { label: 'Step 3-B: RAG 일일 배치', wf: RAG_DAILY_WORKFLOW },
    { label: 'Step 4: 블로그 마케팅 파이프라인', wf: MARKETING_WORKFLOW },
  ];

  for (const { label, wf } of workflows) {
    try {
      const result = await createOrUpdate(wf) as any;
      console.log(`  ✅ ${label} → id: ${result.id}`);
    } catch (err: any) {
      console.error(`  ❌ ${label} 실패: ${err.message}`);
    }
  }

  console.log('\n[n8n Phase 5] 완료');
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
