'use strict';

const assert = require('assert');
const Module = require('module');
const os = require('os');
const path = require('path');

const routePath = path.join(__dirname, '../lib/routes/darwin-callback.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

function responseRecorder() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return body;
    },
  };
}

function request(callbackData: string, overrides: Record<string, unknown> = {}) {
  return {
    headers: { 'x-hub-control-callback-secret': 'darwin-smoke-secret' },
    body: {
      callback_data: callbackData,
      callback_query_id: `query-${callbackData}`,
      from: { id: 42, username: 'master' },
      message: { chat: { id: -1001 } },
    },
    ...overrides,
  };
}

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalEnv = {
    secret: process.env.HUB_CONTROL_CALLBACK_SECRET,
    ids: process.env.HUB_CONTROL_APPROVER_IDS,
    chat: process.env.HUB_CONTROL_APPROVAL_CHAT_ID,
  };
  const states = new Map<string, string>([
    ['proposal-reject', 'pending_approval'],
    ['proposal-approve', 'pending_approval'],
    ['proposal-merge', 'measured'],
    ['제안-한글', 'pending_approval'],
  ]);
  const transitions: Array<{ id: string; to: string; evidence: Record<string, unknown> }> = [];
  const createdTasks = new Map<string, Record<string, unknown>>();
  let implementationCalls = 0;

  process.env.HUB_CONTROL_CALLBACK_SECRET = 'darwin-smoke-secret';
  process.env.HUB_CONTROL_APPROVER_IDS = '42';
  process.env.HUB_CONTROL_APPROVAL_CHAT_ID = '-1001';

  Module._load = function patchedLoad(requestName: string, parent: NodeModule | null, isMain: boolean) {
    if (requestName === '../../../../packages/core/lib/env') return { PROJECT_ROOT: os.tmpdir() };
    if (requestName === '../../../../packages/core/lib/reporting-hub') return { publishToWebhook: async () => ({ ok: true }) };
    if (requestName === '../../../../packages/core/lib/event-lake') return { addFeedback: async () => true };
    if (requestName === '../../../darwin/lib/autonomy-level') return { recordError: () => {} };
    if (requestName === '../../../darwin/lib/research-tasks') {
      return {
        loadTask: async (id: string) => id === 'task-parent'
          ? { id, target: { owner: 'team-jay', repo: 'fixture' }, result: { repoInfo: { name: 'team-jay/fixture' } } }
          : null,
        createTask: (task: Record<string, unknown>) => {
          const id = String(task.id);
          if (!createdTasks.has(id)) createdTasks.set(id, task);
          return createdTasks.get(id);
        },
      };
    }
    if (requestName === '../../../darwin/lib/implementor') {
      return { triggerImplementation: async () => { implementationCalls += 1; } };
    }
    if (requestName === '../../../darwin/lib/proposal-store') {
      return {
        validateProposalId: (id: string) => {
          if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(id) || id.includes('..')) throw new Error('invalid_proposal_id');
          return id;
        },
        loadProposal: (id: string) => states.has(id) ? { id, status: states.get(id), successPredicate: { assertions: [{}, {}, {}] } } : null,
        normalizeProposalState: (status: string) => status === 'pending_approval' ? 'proposed' : status,
        transitionProposal: (id: string, to: string, evidence: Record<string, unknown>) => {
          transitions.push({ id, to, evidence });
          states.set(id, to);
          return { id, status: to, ...evidence };
        },
      };
    }
    return originalLoad.call(this, requestName, parent, isMain);
  };

  try {
    delete require.cache[routePath];
    const { darwinCallbackRoute } = require(routePath);

    const missingSecret = responseRecorder();
    await darwinCallbackRoute(request('darwin_reject:proposal-reject', { headers: {} }), missingSecret);
    assert.strictEqual(missingSecret.statusCode, 403);

    const wrongActor = responseRecorder();
    const wrongActorReq = request('darwin_reject:proposal-reject');
    wrongActorReq.body.from.id = 99;
    await darwinCallbackRoute(wrongActorReq, wrongActor);
    assert.strictEqual(wrongActor.statusCode, 403);

    const missingChat = responseRecorder();
    const missingChatReq = request('darwin_reject:proposal-reject');
    delete missingChatReq.body.message;
    await darwinCallbackRoute(missingChatReq, missingChat);
    assert.strictEqual(missingChat.statusCode, 403);

    const legacyMerge = responseRecorder();
    await darwinCallbackRoute(request('darwin_merge:proposal-merge'), legacyMerge);
    assert.strictEqual(legacyMerge.statusCode, 409);
    assert.strictEqual(legacyMerge.body.error, 'direct_main_merge_retired');

    const rejected = responseRecorder();
    await darwinCallbackRoute(request('darwin_reject:proposal-reject'), rejected);
    assert.strictEqual(rejected.statusCode, 200);
    assert.ok(transitions.some((item) => item.id === 'proposal-reject' && item.to === 'archived'));

    const rejectReplay = responseRecorder();
    await darwinCallbackRoute(request('darwin_reject:proposal-reject'), rejectReplay);
    assert.strictEqual(rejectReplay.statusCode, 409);

    const unicodeId = responseRecorder();
    await darwinCallbackRoute(request('darwin_reject:제안-한글'), unicodeId);
    assert.strictEqual(unicodeId.statusCode, 200);

    const approved = responseRecorder();
    await darwinCallbackRoute(request('darwin_approve:proposal-approve'), approved);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(approved.statusCode, 200);
    assert.strictEqual(states.get('proposal-approve'), 'implementing');
    assert.strictEqual(implementationCalls, 1);

    const replay = responseRecorder();
    await darwinCallbackRoute(request('darwin_approve:proposal-approve'), replay);
    assert.strictEqual(replay.statusCode, 409);
    assert.strictEqual(implementationCalls, 1);

    const skillCreated = responseRecorder();
    await darwinCallbackRoute(request('darwin_create_skill:task-parent'), skillCreated);
    const skillReplay = responseRecorder();
    await darwinCallbackRoute(request('darwin_create_skill:task-parent'), skillReplay);
    assert.strictEqual(skillCreated.statusCode, 200);
    assert.strictEqual(skillReplay.statusCode, 200);
    assert.strictEqual(skillCreated.body.taskId, skillReplay.body.taskId);
    assert.strictEqual(createdTasks.size, 1);

    console.log('✅ darwin callback safety smoke ok');
  } finally {
    Module._load = originalLoad;
    if (originalEnv.secret == null) delete process.env.HUB_CONTROL_CALLBACK_SECRET;
    else process.env.HUB_CONTROL_CALLBACK_SECRET = originalEnv.secret;
    if (originalEnv.ids == null) delete process.env.HUB_CONTROL_APPROVER_IDS;
    else process.env.HUB_CONTROL_APPROVER_IDS = originalEnv.ids;
    if (originalEnv.chat == null) delete process.env.HUB_CONTROL_APPROVAL_CHAT_ID;
    else process.env.HUB_CONTROL_APPROVAL_CHAT_ID = originalEnv.chat;
    delete require.cache[routePath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
