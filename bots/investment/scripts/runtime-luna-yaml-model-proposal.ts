#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { listInvestmentYamlRoutingPolicies } = require('../../../packages/core/lib/agent-llm-routing-adapter.js');
const DEFAULT_OUTPUT = resolve(__dirname, '../output/luna-yaml-model-proposal.md');

const PROPOSALS = Object.freeze({
  luna: 'openai-oauth/gpt-5.4 -> groq/llama-3.3-70b-versatile',
  kairos: 'openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b',
  oracle: 'openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b',
  hermes: 'groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini',
  sophia: 'groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini',
  chronos: 'local-embedding/qwen3-embed-0.6b',
  aria: 'rule-based',
  budget: 'rule-based',
  hanul: 'rule-based',
  hephaestos: 'rule-based',
});

function routeText(policy) {
  if (!policy) return 'invalid';
  if (policy.enabled === false) return 'rule-based';
  return [policy.primary, ...(policy.fallbacks || [])]
    .filter(Boolean)
    .map((entry) => `${entry.provider}/${entry.model}`)
    .join(' -> ');
}

export function buildLunaYamlModelProposal({ generatedAt = new Date().toISOString() } = {}) {
  const policies = listInvestmentYamlRoutingPolicies();
  const rows = policies.map((item) => {
    const current = routeText(item.policy);
    const proposal = PROPOSALS[item.agentName] || current;
    return {
      agent: item.agentName,
      current,
      proposal,
      action: proposal === current ? 'keep' : 'master_review_required',
    };
  });

  const lines = [
    '# Luna YAML Model Proposal',
    '',
    `Generated: ${generatedAt}`,
    '',
    'This file is proposal-only. It does not change YAML routing or live model behavior.',
    '',
    '| agent | current YAML route | proposed route | gate |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.agent} | ${row.current} | ${row.proposal} | ${row.action} |`),
    '',
    '## Guardrails',
    '',
    '- Actual YAML model changes require master approval.',
    '- `LUNA_YAML_ROUTING_ENABLED=false` is the reverse switch; unset defaults to YAML routing.',
    '- Rule-based agents stay non-LLM unless a separate SPEC changes ownership.',
    '- Gemini residue must stay 0 in the YAML runtime path.',
    '',
  ];
  return { ok: true, generatedAt, rows, markdown: lines.join('\n') };
}

async function main() {
  const json = process.argv.includes('--json');
  const noWrite = process.argv.includes('--no-write');
  const outIndex = process.argv.findIndex((arg) => arg === '--out');
  const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : DEFAULT_OUTPUT;
  const report = buildLunaYamlModelProposal();
  if (!noWrite) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report.markdown, 'utf8');
  }
  if (json) console.log(JSON.stringify({ ...report, outputPath: noWrite ? null : out, markdown: undefined }, null, 2));
  else console.log(noWrite ? report.markdown : `wrote ${out}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-yaml-model-proposal failed:' });
}
