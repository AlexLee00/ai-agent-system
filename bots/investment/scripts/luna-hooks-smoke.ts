#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PRE_HOOK = path.join(REPO_ROOT, '.claude/hooks/scripts/luna-pretooluse-policy-check.sh');
const POST_HOOK = path.join(REPO_ROOT, '.claude/hooks/scripts/luna-posttooluse-feedback.sh');

function runHook(script, payload, env = {}) {
  return spawnSync(script, {
    cwd: REPO_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

export function runLunaHooksSmoke() {
  const temp = mkdtempSync(path.join(tmpdir(), 'luna-hooks-smoke-'));
  const killSwitchPath = path.join(temp, 'kill-switch.json');

  try {
    const passNonLuna = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passNonLuna.status, 0, passNonLuna.stderr || passNonLuna.stdout);

    writeFileSync(killSwitchPath, JSON.stringify({ active: false }), 'utf8');
    const passLuna = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s smoke:luna-regime-llm' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passLuna.status, 0, passLuna.stderr || passLuna.stdout);

    const passEntryShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-entry-llm-shadow -- --json --max-llm-calls=0' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passEntryShadow.status, 0, passEntryShadow.stderr || passEntryShadow.stdout);

    const passDynamicTpSlShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-dynamic-tpsl-shadow -- --json --max-llm-calls=0' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passDynamicTpSlShadow.status, 0, passDynamicTpSlShadow.stderr || passDynamicTpSlShadow.stdout);

    const passMetaReflexionShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-meta-reflexion-shadow -- --json --max-llm-calls=0 --layer=all' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passMetaReflexionShadow.status, 0, passMetaReflexionShadow.stderr || passMetaReflexionShadow.stdout);

    const passFactorModelShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-factor-model-shadow -- --json --limit=10 --exchanges=binance,kis_overseas' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passFactorModelShadow.status, 0, passFactorModelShadow.stderr || passFactorModelShadow.stdout);

    const passStatArbShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-stat-arb-shadow -- --json --limit=10 --strategy=all --exchanges=binance,kis_overseas' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passStatArbShadow.status, 0, passStatArbShadow.stderr || passStatArbShadow.stdout);

    const passRlPolicyShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-rl-policy-shadow -- --json --limit=10 --max-inference-calls=0 --exchanges=binance,kis_overseas' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passRlPolicyShadow.status, 0, passRlPolicyShadow.stderr || passRlPolicyShadow.stdout);

    const passRiskSimulationShadow = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-monte-carlo-stress-shadow -- --json --limit=10 --analysis=all --exchanges=binance,kis_overseas --scenarios=base,2022_luna_ftx' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passRiskSimulationShadow.status, 0, passRiskSimulationShadow.stderr || passRiskSimulationShadow.stdout);

    const passCommunicationInfraGate = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-communication-infra-gate -- --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passCommunicationInfraGate.status, 0, passCommunicationInfraGate.stderr || passCommunicationInfraGate.stdout);

    const passHybridPromotionGate = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-gate -- --json --no-db --hours=168' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passHybridPromotionGate.status, 0, passHybridPromotionGate.stderr || passHybridPromotionGate.stdout);

    const passHybridPromotionReview = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-review -- --json --no-db --hours=168' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(passHybridPromotionReview.status, 0, passHybridPromotionReview.stderr || passHybridPromotionReview.stdout);

    writeFileSync(killSwitchPath, JSON.stringify({ active: true }), 'utf8');
    const dynamicTpSlReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-dynamic-tpsl-shadow -- --json --max-llm-calls=0' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(dynamicTpSlReadonly.status, 0, dynamicTpSlReadonly.stderr || dynamicTpSlReadonly.stdout);

    const metaReflexionReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-meta-reflexion-shadow -- --json --max-llm-calls=0 --layer=l2' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(metaReflexionReadonly.status, 0, metaReflexionReadonly.stderr || metaReflexionReadonly.stdout);

    const factorModelReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-factor-model-shadow -- --json --limit=5 --hours=24' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(factorModelReadonly.status, 0, factorModelReadonly.stderr || factorModelReadonly.stdout);

    const statArbReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-stat-arb-shadow -- --json --limit=5 --hours=24 --strategy=mean_reversion' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(statArbReadonly.status, 0, statArbReadonly.stderr || statArbReadonly.stdout);

    const rlPolicyReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-rl-policy-shadow -- --json --limit=5 --hours=24 --max-inference-calls=0' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(rlPolicyReadonly.status, 0, rlPolicyReadonly.stderr || rlPolicyReadonly.stdout);

    const riskSimulationReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-monte-carlo-stress-shadow -- --json --limit=5 --hours=24 --simulations=200 --analysis=stress_test --scenario=2022_luna_ftx' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(riskSimulationReadonly.status, 0, riskSimulationReadonly.stderr || riskSimulationReadonly.stdout);

    const communicationInfraReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-communication-infra-gate -- --json --strict' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(communicationInfraReadonly.status, 0, communicationInfraReadonly.stderr || communicationInfraReadonly.stdout);

    const hybridPromotionReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-gate -- --json --strict --no-db --hours=168' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(hybridPromotionReadonly.status, 0, hybridPromotionReadonly.stderr || hybridPromotionReadonly.stdout);

    const hybridPromotionReviewReadonly = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-review -- --json --strict --no-db --hours=168' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(hybridPromotionReviewReadonly.status, 0, hybridPromotionReviewReadonly.stderr || hybridPromotionReviewReadonly.stdout);

    const dynamicTpSlChainedBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-dynamic-tpsl-shadow -- --json --max-llm-calls=0 ; npm --prefix bots/investment run -s luna -- --symbol=BTC/USDT' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(dynamicTpSlChainedBlocked.status, 2, dynamicTpSlChainedBlocked.stderr || dynamicTpSlChainedBlocked.stdout);
    assert.match(`${dynamicTpSlChainedBlocked.stdout}\n${dynamicTpSlChainedBlocked.stderr}`, /Kill Switch|kill switch/i);

    const blocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s luna -- --symbol=BTC/USDT' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /Kill Switch|kill switch/i);

    const entryShadowBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-entry-llm-shadow -- --apply --confirm=luna-entry-llm-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(entryShadowBlocked.status, 2, entryShadowBlocked.stderr || entryShadowBlocked.stdout);
    assert.match(`${entryShadowBlocked.stdout}\n${entryShadowBlocked.stderr}`, /Kill Switch|kill switch/i);

    const dynamicTpSlBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-dynamic-tpsl-shadow -- --apply --confirm=luna-dynamic-tpsl-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(dynamicTpSlBlocked.status, 2, dynamicTpSlBlocked.stderr || dynamicTpSlBlocked.stdout);
    assert.match(`${dynamicTpSlBlocked.stdout}\n${dynamicTpSlBlocked.stderr}`, /Kill Switch|kill switch/i);

    const metaReflexionBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-meta-reflexion-shadow -- --apply --confirm=luna-meta-reflexion-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(metaReflexionBlocked.status, 2, metaReflexionBlocked.stderr || metaReflexionBlocked.stdout);
    assert.match(`${metaReflexionBlocked.stdout}\n${metaReflexionBlocked.stderr}`, /Kill Switch|kill switch/i);

    const factorModelBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-factor-model-shadow -- --apply --confirm=luna-factor-model-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(factorModelBlocked.status, 2, factorModelBlocked.stderr || factorModelBlocked.stdout);
    assert.match(`${factorModelBlocked.stdout}\n${factorModelBlocked.stderr}`, /Kill Switch|kill switch/i);

    const statArbBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-stat-arb-shadow -- --apply --confirm=luna-stat-arb-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(statArbBlocked.status, 2, statArbBlocked.stderr || statArbBlocked.stdout);
    assert.match(`${statArbBlocked.stdout}\n${statArbBlocked.stderr}`, /Kill Switch|kill switch/i);

    const rlPolicyBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-rl-policy-shadow -- --apply --confirm=luna-rl-policy-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(rlPolicyBlocked.status, 2, rlPolicyBlocked.stderr || rlPolicyBlocked.stdout);
    assert.match(`${rlPolicyBlocked.stdout}\n${rlPolicyBlocked.stderr}`, /Kill Switch|kill switch/i);

    const riskSimulationBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-monte-carlo-stress-shadow -- --apply --confirm=luna-monte-carlo-stress-shadow --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(riskSimulationBlocked.status, 2, riskSimulationBlocked.stderr || riskSimulationBlocked.stdout);
    assert.match(`${riskSimulationBlocked.stdout}\n${riskSimulationBlocked.stderr}`, /Kill Switch|kill switch/i);

    const communicationInfraApplyBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-communication-infra-gate -- --apply --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(communicationInfraApplyBlocked.status, 2, communicationInfraApplyBlocked.stderr || communicationInfraApplyBlocked.stdout);
    assert.match(`${communicationInfraApplyBlocked.stdout}\n${communicationInfraApplyBlocked.stderr}`, /Kill Switch|kill switch/i);

    const hybridPromotionApplyBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-gate -- --apply --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(hybridPromotionApplyBlocked.status, 2, hybridPromotionApplyBlocked.stderr || hybridPromotionApplyBlocked.stdout);
    assert.match(`${hybridPromotionApplyBlocked.stdout}\n${hybridPromotionApplyBlocked.stderr}`, /Kill Switch|kill switch/i);

    const hybridPromotionReviewApplyBlocked = runHook(PRE_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-review -- --apply --json' },
    }, { LUNA_HOOK_TEST_MODE: 'true', LUNA_HOOK_KILL_SWITCH_FILE: killSwitchPath });
    assert.equal(hybridPromotionReviewApplyBlocked.status, 2, hybridPromotionReviewApplyBlocked.stderr || hybridPromotionReviewApplyBlocked.stdout);
    assert.match(`${hybridPromotionReviewApplyBlocked.stdout}\n${hybridPromotionReviewApplyBlocked.stderr}`, /Kill Switch|kill switch/i);

    const post = runHook(POST_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'npm --prefix bots/investment run -s smoke:luna-regime-llm' },
      tool_response: { ok: true },
    }, { HUB_URL: 'http://127.0.0.1:1' });
    assert.equal(post.status, 0, post.stderr || post.stdout);

    return {
      ok: true,
      smoke: 'luna-hooks-phase1',
      nonLunaPass: true,
      lunaPass: true,
      killSwitchBlocked: true,
      entryShadowCommandChecked: true,
      dynamicTpSlShadowCommandChecked: true,
      metaReflexionShadowCommandChecked: true,
      factorModelShadowCommandChecked: true,
      statArbShadowCommandChecked: true,
      rlPolicyShadowCommandChecked: true,
      riskSimulationShadowCommandChecked: true,
      communicationInfraGateCommandChecked: true,
      hybridPromotionGateCommandChecked: true,
      hybridPromotionReviewCommandChecked: true,
      dynamicTpSlChainedBlocked: true,
      postHookFailOpen: true,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const result = runLunaHooksSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna hooks smoke 실패:',
  });
}
