'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const applicatorPath = path.join(__dirname, '../lib/applicator.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalProposalTimeout = process.env.DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS;
  const originalPrototypeTimeout = process.env.DARWIN_APPLICATOR_PROTOTYPE_TIMEOUT_MS;
  const capturedRequests: Array<Record<string, unknown>> = [];

  delete process.env.DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS;
  delete process.env.DARWIN_APPLICATOR_PROTOTYPE_TIMEOUT_MS;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../../../packages/core/lib/hub-client') {
      return {
        callHubLlm: async (llmRequest: Record<string, unknown>) => {
          capturedRequests.push(llmRequest);
          if (llmRequest.taskType === 'proposal_generation') {
            return { text: '<think>hidden chain-of-thought</think>\nproposal ok' };
          }
          return { text: '```js\nmodule.exports = function prototype() { return true; };\n```' };
        },
      };
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => ({ ok: true }) };
    }
    if (request === '../../../packages/core/lib/event-lake') {
      return { record: async () => null, addFeedback: async () => null };
    }
    if (request === './proposal-store') {
      return {
        SANDBOX_DIR: '/tmp',
        ensureDirs: () => {},
        buildProposalId: () => 'proposal-test',
        saveProposal: () => '/tmp/proposal-test.json',
      };
    }
    if (request === './autonomy-level') {
      return { requiresApproval: () => true };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[applicatorPath];
    const applicator = require(applicatorPath);
    const paper = {
      arxiv_id: '2606.13598',
      title: 'Reward Modeling for Multi-Agent Orchestration',
      korean_summary: '멀티에이전트 오케스트레이션 보상 모델링',
      relevance_score: 8,
      reason: 'Darwin graft proposal path smoke',
    };

    const proposal = await applicator.generateProposal(paper);
    const prototype = await applicator.generatePrototype(paper, proposal);

    assert.strictEqual(proposal, 'proposal ok');
    assert.match(prototype, /module\.exports/);
    assert.strictEqual(capturedRequests.length, 2);

    const proposalRequest = capturedRequests[0];
    assert.strictEqual(proposalRequest.callerTeam, 'darwin');
    assert.strictEqual(proposalRequest.agent, 'darwin.synthesis');
    assert.strictEqual(proposalRequest.selectorKey, 'darwin.agent_policy');
    assert.strictEqual(proposalRequest.tokenBudgetProfile, 'darwin_research');
    assert.strictEqual(proposalRequest.taskType, 'proposal_generation');
    assert.strictEqual(proposalRequest.runtimePurpose, 'proposal_generation');
    assert.strictEqual(proposalRequest.timeoutMs, 120_000);

    const prototypeRequest = capturedRequests[1];
    assert.strictEqual(prototypeRequest.callerTeam, 'darwin');
    assert.strictEqual(prototypeRequest.agent, 'darwin.edison');
    assert.strictEqual(prototypeRequest.selectorKey, 'darwin.agent_policy');
    assert.strictEqual(prototypeRequest.tokenBudgetProfile, 'darwin_research');
    assert.strictEqual(prototypeRequest.taskType, 'prototype_generation');
    assert.strictEqual(prototypeRequest.runtimePurpose, 'prototype_generation');
    assert.strictEqual(prototypeRequest.timeoutMs, 120_000);

    assert.deepStrictEqual(applicator._testOnly_applicatorTimeouts, {
      proposal: 120_000,
      prototype: 120_000,
    });
    console.log('✅ darwin applicator LLM budget smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[applicatorPath];
    if (originalProposalTimeout === undefined) {
      delete process.env.DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS;
    } else {
      process.env.DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS = originalProposalTimeout;
    }
    if (originalPrototypeTimeout === undefined) {
      delete process.env.DARWIN_APPLICATOR_PROTOTYPE_TIMEOUT_MS;
    } else {
      process.env.DARWIN_APPLICATOR_PROTOTYPE_TIMEOUT_MS = originalPrototypeTimeout;
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
