// @ts-nocheck
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_FIELDS = [
  'name',
  'tier',
  'runtime',
  'owner',
  'capabilities',
  'llmPolicyRef',
  'inputs',
  'outputs',
  'collaboration',
  'killSwitches',
  'memory_layers',
  'llm_routing',
  'persona',
  'constitution',
];

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === '[]') return [];
  if (value === '{}') return {};
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch {
      if (value.startsWith('[')) {
        return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
      }
    }
  }
  return value.replace(/^['"]|['"]$/g, '');
}

export function parseAgentYaml(text = '') {
  const data = {};
  const lines = String(text).split(/\r?\n/);
  let currentKey = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      const rawValue = String(match[2] || '').trim();
      if (rawValue === '|') {
        const block = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (/^[A-Za-z0-9_-]+:\s*/.test(next)) break;
          i++;
          block.push(next.replace(/^  ?/, ''));
        }
        data[currentKey] = block.join('\n').trim();
        continue;
      }
      data[currentKey] = rawValue ? parseScalar(rawValue) : [];
      continue;
    }
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(listMatch[1]));
    }
  }
  if (!data.collaboration || Array.isArray(data.collaboration)) {
    data.collaboration = {
      upstream: data.upstream || [],
      downstream: data.downstream || [],
      parallel: data.parallel || [],
    };
  }
  return data;
}

export function validateAgentDefinition(agent = {}) {
  const missing = REQUIRED_FIELDS.filter((field) => agent[field] == null);
  const errors = [];
  if (missing.length) errors.push(`missing:${missing.join(',')}`);
  for (const field of ['capabilities', 'inputs', 'outputs', 'killSwitches']) {
    if (!Array.isArray(agent[field])) errors.push(`${field}:must_be_array`);
  }
  if (!Array.isArray(agent.memory_layers) || agent.memory_layers.length === 0) {
    errors.push('memory_layers:must_be_non_empty_array');
  }
  if (!agent.llm_routing || typeof agent.llm_routing !== 'object' || Array.isArray(agent.llm_routing)) {
    errors.push('llm_routing:must_be_object');
  } else {
    if (!agent.llm_routing.primary) errors.push('llm_routing.primary:required');
    if (!Array.isArray(agent.llm_routing.fallbacks)) errors.push('llm_routing.fallbacks:must_be_array');
  }
  for (const field of ['persona', 'constitution']) {
    if (String(agent[field] || '').trim().length < 20) errors.push(`${field}:too_short`);
  }
  for (const field of ['upstream', 'downstream', 'parallel']) {
    if (!Array.isArray(agent.collaboration?.[field])) errors.push(`collaboration.${field}:must_be_array`);
  }
  if (!String(agent.name || '').match(/^[a-z][a-z0-9-]*$/)) errors.push('name:invalid');
  return { ok: errors.length === 0, errors };
}

export function loadAgentDefinition(path) {
  const definition = parseAgentYaml(readFileSync(path, 'utf8'));
  const validation = validateAgentDefinition(definition);
  return { ...definition, sourcePath: resolve(path), validation };
}

export function listAgentDefinitions({ teamDir = new URL('../team', import.meta.url).pathname } = {}) {
  return readdirSync(teamDir)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort()
    .map((file) => loadAgentDefinition(join(teamDir, file)));
}

export function getAgentDefinition(name, opts = {}) {
  return listAgentDefinitions(opts).find((agent) => agent.name === name) || null;
}

export default {
  parseAgentYaml,
  validateAgentDefinition,
  loadAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
};
