function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function requestJson(baseUrl, token, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function main() {
  const originalToken = process.env.HUB_AUTH_TOKEN;
  const originalPlannerHeuristic = process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;
  const originalApproverIds = process.env.HUB_CONTROL_APPROVER_IDS;
  const originalApproverUsernames = process.env.HUB_CONTROL_APPROVER_USERNAMES;
  const originalApprovalTopicId = process.env.HUB_CONTROL_APPROVAL_TOPIC_ID;
  const originalApprovalChatId = process.env.HUB_CONTROL_APPROVAL_CHAT_ID;
  const originalControlCallbackSecret = process.env.HUB_CONTROL_CALLBACK_SECRET;
  const originalAllowDirectApprove = process.env.HUB_CONTROL_ALLOW_DIRECT_APPROVE;
  const smokeToken = 'hub-control-smoke-token';
  const smokeCallbackSecret = 'hub-control-callback-smoke-secret';
  process.env.HUB_AUTH_TOKEN = smokeToken;
  process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = '1';
  process.env.HUB_CONTROL_APPROVER_IDS = '9001';
  process.env.HUB_CONTROL_APPROVER_USERNAMES = '';
  process.env.HUB_CONTROL_APPROVAL_TOPIC_ID = '777';
  process.env.HUB_CONTROL_APPROVAL_CHAT_ID = '-100123';
  process.env.HUB_CONTROL_CALLBACK_SECRET = smokeCallbackSecret;
  delete process.env.HUB_CONTROL_ALLOW_DIRECT_APPROVE;

  try {
    const { resolveHubCallbackTarget } = require('../lib/telegram/callback-router.ts');
    const {
      callHubControlTool,
      listHubControlTools,
    } = require('../lib/control/tool-registry.ts');

    const target1 = resolveHubCallbackTarget('hub_control:approve:run_123');
    const target2 = resolveHubCallbackTarget('darwin_approve:42');
    const target3 = resolveHubCallbackTarget('noop');
    assert(target1?.route === '/hub/control/callback', 'expected hub_control callback route');
    assert(target2?.route === '/hub/darwin/callback', 'expected darwin compatibility callback route');
    assert(target3 == null, 'expected unsupported callback to return null');

    const catalog = listHubControlTools();
    assert(catalog.some((tool) => tool.name === 'hub.health.query'), 'expected hub.health.query tool');
    assert(catalog.some((tool) => tool.name === 'repo.command.run'), 'expected repo.command.run tool in registry');

    const disabledTool = await callHubControlTool('repo.command.run', { cmd: 'echo hi' }, {});
    assert(disabledTool.ok === false, 'expected mutating tool disabled');
    assert(disabledTool.error === 'mutating_tool_disabled', 'expected disabled tool error');

    const busRegister = await callHubControlTool('agent_bus.register', {
      agentId: 'diagnoser-1',
      roles: ['diagnoser'],
      tools: ['hub.health.query'],
    }, {});
    assert(busRegister.ok === true, 'expected agent_bus.register success');

    const subagentPolicy = await callHubControlTool('subagent.validate', {
      contextSummary: 'incident triage',
      allowedTools: ['hub.health.query'],
      parentTools: ['hub.health.query', 'launchd.status'],
      maxConcurrency: 2,
      maxDepth: 2,
    }, {});
    assert(subagentPolicy.ok === true && subagentPolicy.result.ok === true, 'expected subagent policy validation success');

    const { createHubApp } = require('../src/app.ts');
    const app = createHubApp({
      isShuttingDown: () => false,
      isStartupComplete: () => true,
    });

    await withServer(app, async (baseUrl) => {
      const planResp = await requestJson(baseUrl, smokeToken, '/hub/control/plan', {
        message: '루나팀 상태 점검해줘',
        team: 'luna',
        dryRun: true,
      });
      assert(planResp.status === 200, `expected plan route 200, got ${planResp.status}`);
      assert(planResp.body.ok === true, 'expected plan route ok');
      assert(typeof planResp.body.run_id === 'string' && planResp.body.run_id.length > 0, 'expected run_id');
      assert(planResp.body.plan?.playbook?.phases?.length >= 6, 'expected playbook phases');

      const executeResp = await requestJson(baseUrl, smokeToken, '/hub/control/execute', {
        run_id: planResp.body.run_id,
      });
      assert(executeResp.status === 200, `expected execute route 200, got ${executeResp.status}`);
      assert(executeResp.body.ok === true, 'expected execute route ok');
      assert(executeResp.body.dry_run === true, 'expected dry run execute');

      const mutatingPlanResp = await requestJson(baseUrl, smokeToken, '/hub/control/plan', {
        message: '허브 서비스를 재시작 실행해줘',
        team: 'hub',
        dryRun: true,
      });
      assert(mutatingPlanResp.status === 200, `expected mutating plan 200, got ${mutatingPlanResp.status}`);
      assert(mutatingPlanResp.body.ok === true, 'expected mutating plan ok');
      assert(mutatingPlanResp.body.approval?.required === true, 'expected approval required for mutating plan');
      assert(typeof mutatingPlanResp.body.approval?.callback_data?.approve === 'string', 'expected approval callback data');

      const blockedExecuteResp = await requestJson(baseUrl, smokeToken, '/hub/control/execute', {
        run_id: mutatingPlanResp.body.run_id,
      });
      assert(blockedExecuteResp.status === 403, `expected blocked execute 403, got ${blockedExecuteResp.status}`);
      assert(
        blockedExecuteResp.body.error === 'approval_required_for_mutating_plan',
        'expected approval required error for mutating execute',
      );

      const approveCallbackData = mutatingPlanResp.body.approval.callback_data.approve;
      const trustedCallbackHeaders = {
        'x-hub-control-callback-secret': smokeCallbackSecret,
      };
      const directApproveMissingActor = await requestJson(baseUrl, smokeToken, `/hub/control/runs/${mutatingPlanResp.body.run_id}/approve`, {
        nonce: approveCallbackData.split(':').at(-1),
      });
      assert(
        directApproveMissingActor.status === 403,
        `expected direct approve without actor blocked 403, got ${directApproveMissingActor.status}`,
      );
      assert(
        directApproveMissingActor.body.error === 'direct_approve_disabled_use_callback',
        'expected direct approve disabled error',
      );

      const callbackWithoutSecretResp = await requestJson(baseUrl, smokeToken, '/hub/control/callback', {
        callback_data: approveCallbackData,
        from: { id: 9001, username: 'approver' },
        message: { chat: { id: '-100123' }, message_thread_id: '777' },
      });
      assert(
        callbackWithoutSecretResp.status === 403,
        `expected callback without trusted header blocked 403, got ${callbackWithoutSecretResp.status}`,
      );
      assert(
        callbackWithoutSecretResp.body.error === 'approval_callback_untrusted_source',
        'expected callback trusted-source error',
      );

      const wrongActorResp = await requestJson(baseUrl, smokeToken, '/hub/control/callback', {
        callback_data: approveCallbackData,
        from: { id: 1234, username: 'outsider' },
        message: { chat: { id: '-100123' }, message_thread_id: '777' },
      }, trustedCallbackHeaders);
      assert(wrongActorResp.status === 403, `expected callback actor reject 403, got ${wrongActorResp.status}`);
      assert(wrongActorResp.body.error === 'approval_actor_not_allowed', 'expected actor restriction error');

      const wrongTopicResp = await requestJson(baseUrl, smokeToken, '/hub/control/callback', {
        callback_data: approveCallbackData,
        from: { id: 9001, username: 'approver' },
        message: { chat: { id: '-100123' }, message_thread_id: '999' },
      }, trustedCallbackHeaders);
      assert(wrongTopicResp.status === 403, `expected callback topic reject 403, got ${wrongTopicResp.status}`);
      assert(wrongTopicResp.body.error === 'approval_topic_mismatch', 'expected topic restriction error');

      const approveResp = await requestJson(baseUrl, smokeToken, '/hub/control/callback', {
        callback_data: approveCallbackData,
        from: { id: 9001, username: 'approver' },
        message: { chat: { id: '-100123' }, message_thread_id: '777' },
      }, trustedCallbackHeaders);
      assert(approveResp.status === 200, `expected callback route 200, got ${approveResp.status}`);
      assert(approveResp.body.status === 'approved', 'expected callback approval status');

      const rerunNonceResp = await requestJson(baseUrl, smokeToken, '/hub/control/callback', {
        callback_data: approveCallbackData,
        from: { id: 9001, username: 'approver' },
        message: { chat: { id: '-100123' }, message_thread_id: '777' },
      }, trustedCallbackHeaders);
      assert(rerunNonceResp.status === 403, `expected nonce replay block 403, got ${rerunNonceResp.status}`);
      assert(rerunNonceResp.body.error === 'approval_nonce_already_consumed', 'expected nonce replay error');

      const executeAfterApprove = await requestJson(baseUrl, smokeToken, '/hub/control/execute', {
        run_id: mutatingPlanResp.body.run_id,
      });
      assert(executeAfterApprove.status === 200, `expected execute after approval 200, got ${executeAfterApprove.status}`);
      assert(executeAfterApprove.body.ok === true, 'expected execute after approval ok');

      const toolResp = await requestJson(baseUrl, smokeToken, '/hub/tools/repo.command.run/call', {
        cmd: 'echo should_not_run',
      });
      assert(toolResp.status === 403, `expected direct mutating tool call 403, got ${toolResp.status}`);
      assert(toolResp.body.error === 'direct_tool_call_requires_control_plan', 'expected direct call block error');

      const busToolResp = await requestJson(baseUrl, smokeToken, '/hub/tools/agent_bus.register/call', {
        agentId: 'direct-write-deny',
      });
      assert(busToolResp.status === 403, `expected direct write tool call 403, got ${busToolResp.status}`);
      assert(busToolResp.body.error === 'direct_tool_call_requires_control_plan', 'expected direct write block');

      const readOnlyToolResp = await requestJson(baseUrl, smokeToken, '/hub/tools/hub.health.query/call', {
        minutes: 5,
      });
      assert(readOnlyToolResp.status === 200, `expected read-only tool call 200, got ${readOnlyToolResp.status}`);
      assert(readOnlyToolResp.body.ok === true, 'expected read-only tool call ok');

      process.env.HUB_CONTROL_APPROVER_IDS = '';
      process.env.HUB_CONTROL_APPROVAL_TOPIC_ID = '';
      process.env.HUB_CONTROL_APPROVAL_CHAT_ID = '';
      const policyMissingPlanResp = await requestJson(baseUrl, smokeToken, '/hub/control/plan', {
        message: '허브 서비스를 재시작 실행해줘',
        team: 'hub',
        dryRun: true,
      });
      assert(
        policyMissingPlanResp.status === 503,
        `expected mutating plan blocked when approval policy missing, got ${policyMissingPlanResp.status}`,
      );
      assert(
        policyMissingPlanResp.body.error === 'approval_policy_not_configured',
        'expected approval policy missing error',
      );
    });

    console.log('control_plane_smoke_ok');
  } finally {
    if (originalToken == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalToken;
    if (originalPlannerHeuristic == null) delete process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;
    else process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = originalPlannerHeuristic;
    if (originalApproverIds == null) delete process.env.HUB_CONTROL_APPROVER_IDS;
    else process.env.HUB_CONTROL_APPROVER_IDS = originalApproverIds;
    if (originalApproverUsernames == null) delete process.env.HUB_CONTROL_APPROVER_USERNAMES;
    else process.env.HUB_CONTROL_APPROVER_USERNAMES = originalApproverUsernames;
    if (originalApprovalTopicId == null) delete process.env.HUB_CONTROL_APPROVAL_TOPIC_ID;
    else process.env.HUB_CONTROL_APPROVAL_TOPIC_ID = originalApprovalTopicId;
    if (originalApprovalChatId == null) delete process.env.HUB_CONTROL_APPROVAL_CHAT_ID;
    else process.env.HUB_CONTROL_APPROVAL_CHAT_ID = originalApprovalChatId;
    if (originalControlCallbackSecret == null) delete process.env.HUB_CONTROL_CALLBACK_SECRET;
    else process.env.HUB_CONTROL_CALLBACK_SECRET = originalControlCallbackSecret;
    if (originalAllowDirectApprove == null) delete process.env.HUB_CONTROL_ALLOW_DIRECT_APPROVE;
    else process.env.HUB_CONTROL_ALLOW_DIRECT_APPROVE = originalAllowDirectApprove;
  }
}

main().catch((error) => {
  console.error('[control-plane-smoke] failed:', error?.message || error);
  process.exit(1);
});
