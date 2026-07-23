'use strict';

const assert = require('assert');
const Module = require('module');
const os = require('os');
const path = require('path');

const applicatorPath = path.join(__dirname, '../lib/applicator.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  let llmCalls = 0;
  let alarmCalls = 0;
  let eventCalls = 0;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../../../packages/core/lib/hub-client') {
      return { callHubLlm: async () => { llmCalls += 1; throw new Error('must_not_call_llm'); } };
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => { alarmCalls += 1; return { ok: true }; } };
    }
    if (request === '../../../packages/core/lib/event-lake') {
      return {
        record: async () => { eventCalls += 1; return null; },
        addFeedback: async () => null,
      };
    }
    if (request === './proposal-store') {
      return {
        SANDBOX_DIR: os.tmpdir(),
        ensureDirs: () => {},
        buildProposalId: () => 'must-not-build',
        saveProposal: () => { throw new Error('must_not_save'); },
        findActiveProposalForPaper: () => ({ id: 'existing-proposal', status: 'pending_approval' }),
      };
    }
    if (request === './autonomy-level') return { requiresApproval: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[applicatorPath];
    const applicator = require(applicatorPath);
    const result = await applicator.apply({
      arxiv_id: '2607.99999',
      title: 'Duplicate active proposal fixture',
      relevance_score: 9,
      domain: 'neuron',
    });
    assert.strictEqual(result.skippedReason, 'active_proposal_exists');
    assert.strictEqual(result.proposalId, 'existing-proposal');
    assert.strictEqual(llmCalls, 0);
    assert.strictEqual(alarmCalls, 0);
    assert.strictEqual(eventCalls, 0);
    console.log('✅ darwin applicator active dedupe smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[applicatorPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
