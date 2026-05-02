#!/usr/bin/env tsx

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

const OAUTH4_OPTIONS = {
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
};

function isAnthropicProvider(entry) {
  return String(entry?.provider || '').trim() === 'anthropic';
}

function runDirectSelectorAudit() {
  const keys = selector.listLLMSelectorKeys();
  const findings = [];
  let checked = 0;

  for (const key of keys) {
    try {
      const chain = selector.selectLLMChain(key, {
        ...OAUTH4_OPTIONS,
        rolloutKey: `selector:${key}`,
      });
      if (!Array.isArray(chain) || chain.length === 0) continue;
      checked += 1;
      for (let index = 0; index < chain.length; index += 1) {
        if (!isAnthropicProvider(chain[index])) continue;
        findings.push({
          scope: 'selector_key',
          key,
          routeIndex: index,
          provider: chain[index]?.provider || null,
          model: chain[index]?.model || null,
        });
      }
    } catch (error) {
      findings.push({
        scope: 'selector_key_error',
        key,
        error: String(error?.message || error),
      });
    }
  }

  return { checked, findings };
}

function runAgentCoverageAudit() {
  const targets = selector.listAgentModelTargets();
  const findings = [];
  let checked = 0;
  const providerCounts = {};

  for (const target of targets) {
    if (!target?.selected || !target?.selectorKey) continue;
    try {
      const chain = selector.selectLLMChain(target.selectorKey, {
        ...OAUTH4_OPTIONS,
        agentName: target.agent,
        team: target.team,
        rolloutKey: `agent:${target.team}:${target.agent}`,
      });
      if (!Array.isArray(chain) || chain.length === 0) continue;
      checked += 1;
      const provider = String(chain[0]?.provider || 'unknown');
      providerCounts[provider] = (providerCounts[provider] || 0) + 1;
      for (let index = 0; index < chain.length; index += 1) {
        if (!isAnthropicProvider(chain[index])) continue;
        findings.push({
          scope: 'agent_selector',
          team: target.team,
          agent: target.agent,
          selectorKey: target.selectorKey,
          routeIndex: index,
          provider: chain[index]?.provider || null,
          model: chain[index]?.model || null,
        });
      }
    } catch (error) {
      findings.push({
        scope: 'agent_selector_error',
        team: target.team,
        agent: target.agent,
        selectorKey: target.selectorKey,
        error: String(error?.message || error),
      });
    }
  }

  return { checked, findings, providerCounts };
}

function main() {
  const direct = runDirectSelectorAudit();
  const agents = runAgentCoverageAudit();
  const findings = [...direct.findings, ...agents.findings];

  const report = {
    ok: findings.length === 0,
    selector_version: OAUTH4_OPTIONS.selectorVersion,
    rollout_percent: OAUTH4_OPTIONS.rolloutPercent,
    checked: {
      selector_keys: direct.checked,
      agent_routes: agents.checked,
      total: direct.checked + agents.checked,
    },
    provider_counts: agents.providerCounts,
    findings,
  };

  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error('[llm-anthropic-primary-audit] failed:', error?.message || error);
  process.exit(1);
}
