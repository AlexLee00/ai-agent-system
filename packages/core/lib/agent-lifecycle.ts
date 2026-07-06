// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const kst = require('./kst');
const env = require('./env');

const personaCache = new Map();
const DEFAULT_SIGMA_LIBRARY_MCP_URL = 'http://127.0.0.1:4097/rpc';
const LIFECYCLE_BEGIN = '<!-- AGENT_LIFECYCLE:BEGIN -->';
const LIFECYCLE_END = '<!-- AGENT_LIFECYCLE:END -->';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeSegment(value = '') {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function clampLimit(value, fallback = 8) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

function repoRoot() {
  return env.PROJECT_ROOT || path.resolve(__dirname, '../../..');
}

function personaPath(team) {
  return path.join(repoRoot(), 'bots', safeSegment(team), 'AGENTS.md');
}

function trimToChars(value = '', maxChars = 600) {
  const text = normalizeText(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function trimBlockToChars(value = '', maxChars = 1800) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function summarizePersona(raw = '', maxChars = 600) {
  const lines = String(raw || '').split(/\r?\n/);
  const summary = [];
  const firstTitle = lines.find((line) => /^#\s+AGENTS\.md/.test(line.trim()));
  if (firstTitle) summary.push(normalizeText(firstTitle.replace(/^#\s*/, '')));

  const spirit = lines.find((line) => /^>\s*[^:：]+[:：]/.test(line.trim()) || /^>\s*.*정신/.test(line.trim()));
  if (spirit) summary.push(normalizeText(spirit.replace(/^>\s*/, '')));

  for (let i = 0; i < lines.length && summary.length < 8; i += 1) {
    const header = lines[i].trim();
    if (!/^##\s+원칙\s+\d+/.test(header)) continue;
    const body = lines.slice(i + 1).find((line) => normalizeText(line) && !line.trim().startsWith('#'));
    const headerText = normalizeText(header.replace(/^##\s*/, ''));
    const bodyText = body ? normalizeText(body) : '';
    summary.push(trimToChars(`${headerText}: ${bodyText}`, 130));
  }

  if (summary.length < 3) {
    for (const line of lines) {
      const text = normalizeText(line.replace(/^#+\s*/, '').replace(/^>\s*/, ''));
      if (!text || summary.includes(text)) continue;
      if (/^(정본|이 파일|---|\|)/.test(text)) continue;
      summary.push(trimToChars(text, 130));
      if (summary.length >= 6) break;
    }
  }

  return trimToChars(summary.filter(Boolean).join(' / '), maxChars);
}

function loadPersona(team, options = {}) {
  const cacheKey = `${safeSegment(team)}:${Number(options.maxChars || 600)}`;
  if (personaCache.has(cacheKey)) return personaCache.get(cacheKey);
  try {
    const filePath = options.filePath || personaPath(team);
    if (!fs.existsSync(filePath)) {
      personaCache.set(cacheKey, '');
      return '';
    }
    const summary = summarizePersona(fs.readFileSync(filePath, 'utf8'), Number(options.maxChars || 600));
    personaCache.set(cacheKey, summary);
    return summary;
  } catch {
    personaCache.set(cacheKey, '');
    return '';
  }
}

function teamAliases(team) {
  const normalized = safeSegment(team);
  const aliases = new Set([normalized]);
  if (normalized === 'investment') aliases.add('luna');
  if (normalized === 'luna') aliases.add('investment');
  if (normalized === 'blog') aliases.add('blo');
  return aliases;
}

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

function collectTeamHints(row = {}) {
  const meta = parseMeta(row.meta);
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  return [
    meta.team,
    meta.agent_team,
    meta.sourceTeam,
    meta.source_ref?.team,
    meta.sourceRef?.team,
    row.team,
    row.source,
    row.sourceKind,
    ...tags,
  ].map((item) => normalizeText(item).toLowerCase()).filter(Boolean);
}

function matchesTeamNamespace(row, team) {
  const aliases = teamAliases(team);
  return collectTeamHints(row).some((hint) => {
    const normalized = hint.replace(/^team:/, '');
    return [...aliases].some((alias) => normalized === alias || normalized.includes(`${alias}_`) || normalized.includes(`${alias}-`));
  });
}

function validationState(row = {}) {
  const meta = parseMeta(row.meta);
  return normalizeText(
    row.libraryCoords?.validation_state
    || meta.libraryCoords?.validation_state
    || row.validation_state
    || '',
  ).toLowerCase();
}

function sourceTagFor(row = {}) {
  if (row.id != null && row.id !== '') return `vault-entry:${row.id}`;
  return normalizeText(row.source || row.title || 'sigma-memory').slice(0, 80);
}

function normalizeMemory(row = {}) {
  return {
    id: row.id ?? null,
    title: normalizeText(row.title || 'untitled memory'),
    summary: normalizeText(row.contentPreview || row.summary || row.content || '').slice(0, 220),
    source: row.source || null,
    sourceTag: sourceTagFor(row),
    similarity: Number.isFinite(Number(row.similarity)) ? Number(row.similarity) : null,
    validationState: validationState(row) || 'unknown',
  };
}

function extractToolJson(body = {}) {
  const direct = body?.result;
  if (direct?.content?.[0]?.json) return direct.content[0].json;
  if (direct?.content?.[0]?.text) {
    try {
      return JSON.parse(direct.content[0].text);
    } catch {
      return {};
    }
  }
  return direct || body;
}

async function callSigmaLibrarySearch(args, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, skipped: true, reason: 'fetch_unavailable', results: [] };
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Math.min(10000, Number(options.timeoutMs || 3000)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(options.url || process.env.SIGMA_LIBRARY_MCP_URL || DEFAULT_SIGMA_LIBRARY_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `agent-lifecycle-${Date.now()}`,
        method: 'tools/call',
        params: { name: 'library-search', arguments: args },
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) {
      return { ok: false, skipped: true, reason: body?.error?.message || `http_${res.status}`, results: [] };
    }
    const json = extractToolJson(body);
    return { ok: Boolean(json?.ok ?? true), skipped: false, reason: json?.warning || null, results: Array.isArray(json?.results) ? json.results : [] };
  } catch (error) {
    return { ok: false, skipped: true, reason: error?.message || String(error), results: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function recallMemories({ team, agent, topic, limit = 8, fetch, url, timeoutMs } = {}) {
  const effectiveLimit = clampLimit(limit, 8);
  const query = [safeSegment(team), safeSegment(agent), normalizeText(topic)].filter(Boolean).join(' ');
  if (!query) {
    return { ok: false, skipped: true, reason: 'query_required', requestedLimit: limit, effectiveLimit, memories: [] };
  }
  const response = await callSigmaLibrarySearch({
    query,
    limit: effectiveLimit,
    layerSearchEnabled: true,
    includeRoutingDebug: true,
  }, { fetch, url, timeoutMs });

  const memories = (response.results || [])
    .filter((row) => matchesTeamNamespace(row, team))
    .sort((left, right) => {
      const leftValidated = validationState(left) === 'validated' ? 1 : 0;
      const rightValidated = validationState(right) === 'validated' ? 1 : 0;
      if (leftValidated !== rightValidated) return rightValidated - leftValidated;
      return Number(right.similarity || 0) - Number(left.similarity || 0);
    })
    .slice(0, effectiveLimit)
    .map(normalizeMemory);

  return {
    ok: response.ok,
    skipped: response.skipped,
    reason: response.reason,
    requestedLimit: limit,
    effectiveLimit,
    memories,
  };
}

function buildLifecycleBlock({ persona = '', memories = [], maxChars = 1800 } = {}) {
  const safePersona = trimToChars(persona, 600);
  const safeMemories = (Array.isArray(memories) ? memories : []).slice(0, 10);
  if (!safePersona && safeMemories.length === 0) return '';
  const lines = [LIFECYCLE_BEGIN];
  if (safePersona) {
    lines.push('[BOOT]', safePersona);
  }
  if (safeMemories.length) {
    lines.push('[RECALL]');
    safeMemories.forEach((memory, index) => {
      const summary = memory.summary ? ` — ${trimToChars(memory.summary, 160)}` : '';
      lines.push(`${index + 1}. ${memory.title}${summary} (${memory.sourceTag || 'source:unknown'})`);
    });
  }
  const limit = Number(maxChars || 1800);
  const bodyLimit = Math.max(LIFECYCLE_BEGIN.length, limit - LIFECYCLE_END.length - 1);
  return `${trimBlockToChars(lines.join('\n'), bodyLimit)}\n${LIFECYCLE_END}`;
}

function telemetryPathFor(team, envObj = process.env) {
  return path.resolve(
    envObj.AGENT_LIFECYCLE_TELEMETRY_PATH
    || path.join(os.homedir(), '.ai-agent-system', 'workspace', safeSegment(team), 'lifecycle-telemetry.jsonl'),
  );
}

function recordLifecycleTelemetry(event = {}, options = {}) {
  const team = safeSegment(event.team || options.team || 'unknown');
  const filePath = telemetryPathFor(team, options.env || process.env);
  const payload = {
    at: typeof kst.datetimeStr === 'function' ? kst.datetimeStr() : new Date().toISOString(),
    team,
    ...event,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    return { ok: true, path: filePath, event: payload };
  } catch (error) {
    if (!options.silent) console.warn(`[agent-lifecycle] telemetry append failed: ${error?.message || error}`);
    return { ok: false, path: filePath, error: error?.message || String(error) };
  }
}

async function buildLifecyclePromptContext({
  team,
  agent,
  topic,
  enabled = false,
  limit = 8,
  telemetry = {},
  env: runtimeEnv = process.env,
  fetch,
  recallFn = recallMemories,
  personaFn = loadPersona,
} = {}) {
  if (!enabled) {
    return {
      persona: '',
      recall: {
        ok: true,
        skipped: true,
        reason: 'lifecycle_disabled',
        requestedLimit: limit,
        effectiveLimit: clampLimit(limit, 8),
        memories: [],
      },
      block: '',
      promptBlock: '',
      injected: false,
      telemetry: { ok: true, skipped: true, reason: 'lifecycle_disabled' },
    };
  }
  const persona = personaFn(team);
  const recall = await recallFn({ team, agent, topic, limit, fetch });
  const block = buildLifecycleBlock({ persona, memories: recall.memories || [] });
  const injected = Boolean(block);
  const telemetryResult = recordLifecycleTelemetry({
    team,
    agent,
    topic: normalizeText(topic).slice(0, 180),
    enabled: Boolean(enabled),
    injected,
    personaChars: persona.length,
    recallCount: (recall.memories || []).length,
    recallSkipped: Boolean(recall.skipped),
    topSources: (recall.memories || []).slice(0, 3).map((memory) => memory.sourceTag),
    ...telemetry,
  }, { env: runtimeEnv, silent: true });
  return {
    persona,
    recall,
    block,
    promptBlock: injected ? block : '',
    injected,
    telemetry: telemetryResult,
  };
}

module.exports = {
  LIFECYCLE_BEGIN,
  LIFECYCLE_END,
  clampLimit,
  loadPersona,
  summarizePersona,
  recallMemories,
  buildLifecycleBlock,
  recordLifecycleTelemetry,
  buildLifecyclePromptContext,
  _testOnly: {
    matchesTeamNamespace,
    normalizeMemory,
    validationState,
    telemetryPathFor,
  },
};
