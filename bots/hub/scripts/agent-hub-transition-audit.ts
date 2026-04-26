import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const { PROFILES } = require('../lib/runtime-profiles.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const REGISTRY_SOURCES = [
  {
    path: 'bots/orchestrator/scripts/seed-agent-registry.ts',
    arrayName: 'AGENTS',
  },
  {
    path: 'bots/orchestrator/scripts/seed-team-reinforce-phase6.ts',
    arrayName: 'NEW_AGENTS',
  },
  {
    path: 'bots/orchestrator/scripts/seed-blog-reinforce.ts',
    arrayName: 'BLOG_REINFORCEMENTS',
  },
  {
    path: 'bots/orchestrator/scripts/seed-blog-agents-phase2.ts',
    arrayName: 'NEW_BLOG_AGENTS',
  },
  {
    path: 'bots/orchestrator/scripts/seed-three-teams.ts',
    arrayName: 'NEW_AGENTS',
  },
  {
    path: 'bots/orchestrator/scripts/seed-sigma-expansion.ts',
    arrayName: 'NEW_SIGMA_AGENTS',
  },
];

function extractArrayLiteral(source: string, arrayName: string): string {
  const marker = `const ${arrayName} = [`;
  const markerIndex = source.indexOf(marker);
  assert(markerIndex >= 0, `missing ${arrayName} declaration`);

  const start = source.indexOf('[', markerIndex);
  assert(start >= 0, `missing ${arrayName} array start`);

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`unterminated ${arrayName} array`);
}

function loadAgentsFromSource(sourcePath: string, arrayName: string) {
  const absolutePath = path.join(REPO_ROOT, sourcePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const literal = extractArrayLiteral(source, arrayName);
  const runtimeConfig = sourcePath.includes('seed-blog-')
    ? (purpose = 'default') => ({
      llm_management: 'runtime-managed',
      runtime_team: 'blog',
      runtime_purpose: purpose,
    })
    : sourcePath.includes('seed-sigma-expansion')
      ? (purpose = 'analysis') => ({
        llm_management: 'runtime-managed',
        runtime_team: 'sigma',
        runtime_purpose: purpose,
      })
      : (team: string, purpose = 'default') => {
      return {
        llm_management: 'runtime-managed',
        runtime_team: team,
        runtime_purpose: purpose,
      };
    };
  const agents = vm.runInNewContext(`(${literal})`, { runtimeConfig }, { timeout: 1000 });
  assert(Array.isArray(agents), `${sourcePath}:${arrayName} must evaluate to an array`);
  return agents.map((agent: any) => ({ ...agent, _source: sourcePath }));
}

function getRuntimeTeam(agent: any): string {
  if (agent.config?.runtime_team) return String(agent.config.runtime_team);
  if (agent.team === 'jay') return 'orchestrator';
  return String(agent.team || '');
}

function getRuntimePurpose(agent: any): string {
  return String(agent.config?.runtime_purpose || agent.config?.runtime_agent || 'default');
}

function main() {
  const agents = REGISTRY_SOURCES.flatMap((source) => loadAgentsFromSource(source.path, source.arrayName));
  const findings: Array<Record<string, string>> = [];
  let runtimeManaged = 0;
  let nonLlm = 0;

  for (const agent of agents) {
    const management = String(agent.config?.llm_management || '');

    if (agent.llm_model) {
      findings.push({
        code: 'direct_llm_model_metadata',
        source: agent._source,
        agent: String(agent.name),
        team: String(agent.team),
        value: String(agent.llm_model),
      });
      continue;
    }

    if (management === 'non-llm') {
      nonLlm += 1;
      continue;
    }

    if (management !== 'runtime-managed') {
      findings.push({
        code: 'missing_llm_management',
        source: agent._source,
        agent: String(agent.name),
        team: String(agent.team),
      });
      continue;
    }

    runtimeManaged += 1;
    const runtimeTeam = getRuntimeTeam(agent);
    const runtimePurpose = getRuntimePurpose(agent);
    if (!PROFILES[runtimeTeam]?.[runtimePurpose]) {
      findings.push({
        code: 'missing_runtime_profile',
        source: agent._source,
        agent: String(agent.name),
        team: String(agent.team),
        runtime_team: runtimeTeam,
        runtime_purpose: runtimePurpose,
      });
    }
  }

  const summary = {
    ok: findings.length === 0,
    sources: REGISTRY_SOURCES.length,
    agents: agents.length,
    runtime_managed: runtimeManaged,
    non_llm: nonLlm,
    findings,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (findings.length > 0) process.exit(1);
}

main();
