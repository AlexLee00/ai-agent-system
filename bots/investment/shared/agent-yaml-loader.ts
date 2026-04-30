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
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(listMatch[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    currentKey = match[1];
    data[currentKey] = match[2] ? parseScalar(match[2]) : [];
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
