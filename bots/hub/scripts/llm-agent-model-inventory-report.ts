#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..');
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'bots', 'registry.json');
const OUTPUT_JSON = path.resolve(
  process.env.LLM_AGENT_MODEL_INVENTORY_JSON
    || path.join(PROJECT_ROOT, 'bots', 'hub', 'output', 'llm-agent-model-inventory-report.json'),
);
const OUTPUT_MD = path.resolve(
  process.env.LLM_AGENT_MODEL_INVENTORY_MD
    || path.join(PROJECT_ROOT, 'docs', 'hub', 'LLM_AGENT_MODEL_INVENTORY_REPORT.md'),
);

const SELECTOR_OPTIONS = {
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
};

function clean(value: any): string {
  return String(value || '').trim();
}

function canonicalTeamForRegistry(id: string, bot: any): string {
  if (bot?.canonicalTeam) return clean(bot.canonicalTeam);
  if (clean(bot?.team) === 'blog') return 'blog';
  if (id.startsWith('blog-')) return 'blog';
  if (['reservation', 'ska', 'eve'].includes(id)) return 'ska';
  return id;
}

function agentNameForRegistry(id: string, bot: any): string {
  if (id.startsWith('blog-')) return id.replace(/^blog-/, '');
  if (id === 'reservation') return 'reservation';
  if (id === 'ska') return 'rebecca';
  return id;
}

function registryStatus(bot: any): string {
  return clean(bot?.status) || clean(bot?.inventoryKind) || 'unknown';
}

function modelLabel(entry: any): string {
  if (!entry) return '';
  const provider = clean(entry.provider);
  const model = clean(entry.model);
  if (!provider && !model) return '';
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function registryModelLabel(model: any): string {
  if (!model) return '';
  if (typeof model === 'string') return model;
  if (typeof model.primary === 'string') return model.primary;
  if (typeof model.live_orchestrator === 'string') return model.live_orchestrator;
  if (typeof model.live_llm_agents === 'string') return model.live_llm_agents;
  return '';
}

function registryFallbackLabels(model: any): string[] {
  if (!model || typeof model !== 'object') return [];
  if (Array.isArray(model.fallbacks)) return model.fallbacks.map(clean).filter(Boolean);
  return [];
}

function providerOf(label: string): string {
  const normalized = clean(label);
  if (!normalized) return 'missing';
  if (normalized.startsWith('openai-oauth/') || normalized.startsWith('gpt-') || normalized.startsWith('o')) return 'openai-oauth';
  if (normalized.startsWith('gemini-cli-oauth/') || normalized.startsWith('gemini-oauth/') || normalized.startsWith('gemini-')) return 'gemini-cli-oauth';
  if (normalized.startsWith('groq/') || normalized.startsWith('meta-llama/') || normalized.startsWith('openai/gpt-oss-') || normalized.startsWith('qwen/')) return 'groq';
  if (normalized.startsWith('claude-code/') || normalized.startsWith('anthropic/') || normalized.startsWith('claude-')) return 'claude-code';
  if (normalized.startsWith('local/') || normalized.startsWith('ollama/')) return 'local';
  return normalized.split('/')[0] || 'unknown';
}

function addCount(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] || 0) + 1;
}

function getChainForTarget(target: any): any[] {
  if (!target?.selectorKey || target?.blockReason) return [];
  try {
    return selector.selectLLMChain(target.selectorKey, {
      ...SELECTOR_OPTIONS,
      team: target.team,
      agentName: target.agent,
      rolloutKey: `inventory:${target.team}:${target.agent}`,
    });
  } catch (error: any) {
    return [{ provider: 'error', model: clean(error?.message || error) }];
  }
}

function rowFromTarget(target: any): any {
  const chain = getChainForTarget(target);
  const primary = modelLabel(chain[0]);
  const fallbacks = chain.slice(1).map(modelLabel).filter(Boolean);
  return {
    source: 'selector',
    team: clean(target?.canonicalTeam || target?.team),
    namespace: clean(target?.team),
    agent: clean(target?.agent),
    kind: clean(target?.kind),
    status: target?.blockReason ? 'blocked' : 'selected',
    selectorKey: target?.selectorKey || null,
    primary,
    fallbacks,
    modelStatus: primary ? 'selector_chain' : (target?.blockReason ? 'blocked' : 'missing_chain'),
    blockReason: target?.blockReason || null,
    countable: Boolean(target?.countable),
  };
}

function registryRows(): any[] {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const bots = registry?.bots || {};
  const rows: any[] = [];

  for (const [id, bot] of Object.entries(bots)) {
    const canonicalTeam = canonicalTeamForRegistry(id, bot);
    const status = registryStatus(bot);
    const hasSubAgents = bot?.subBots && typeof bot.subBots === 'object';
    const hasAgents = Array.isArray(bot?.agents);
    const kind = clean(bot?.inventoryKind)
      || (['planned', 'pending_runtime'].includes(status) ? status : (hasSubAgents || hasAgents ? 'team_container' : 'visible_agent'));
    const topAgent = agentNameForRegistry(id, bot);
    const topModel = registryModelLabel(bot?.model);
    const topFallbacks = registryFallbackLabels(bot?.model);
    const topModelStatus = hasSubAgents || hasAgents
      ? 'team_container'
      : (id === 'hub' ? 'non_llm_service' : (topModel ? 'registry_model_only' : 'missing_model'));

    rows.push({
      source: 'registry',
      team: canonicalTeam,
      namespace: id,
      agent: topAgent,
      kind,
      status,
      selectorKey: null,
      primary: topModelStatus === 'team_container' || topModelStatus === 'non_llm_service' ? '' : topModel,
      fallbacks: topModelStatus === 'team_container' || topModelStatus === 'non_llm_service' ? [] : topFallbacks,
      modelStatus: topModelStatus,
      blockReason: ['planned', 'pending_runtime'].includes(kind) || ['planned', 'pending_runtime'].includes(status) ? kind : null,
      countable: kind === 'visible_agent' && status !== 'planned' && topModelStatus !== 'non_llm_service',
      role: clean(bot?.role || bot?.teamRole || bot?.description),
    });

    if (hasSubAgents) {
      for (const [agent, sub] of Object.entries(bot.subBots)) {
        const roleType = clean(sub?.type);
        const isClaudeToolRole = id === 'claude' && ['Explore', 'Plan', 'Bash'].includes(roleType);
        const isAutoDev = id === 'claude' && agent === 'auto-dev';
        const primary = isAutoDev ? 'openai-oauth/gpt-5.4' : (registryModelLabel(sub?.model) || topModel);
        const fallbacks = registryFallbackLabels(sub?.model).length > 0 ? registryFallbackLabels(sub?.model) : topFallbacks;
        rows.push({
          source: 'registry',
          team: canonicalTeam,
          namespace: id,
          agent,
          kind: ['planned', 'pending_runtime'].includes(status) ? status : 'visible_agent',
          status: clean(sub?.status) || status,
          selectorKey: null,
          primary: isClaudeToolRole ? '' : primary,
          fallbacks: isClaudeToolRole ? [] : fallbacks,
          modelStatus: isClaudeToolRole ? 'non_llm_role' : (primary ? (isAutoDev ? 'auto_dev_implementation_model' : 'registry_model_only') : 'missing_model'),
          blockReason: ['planned', 'pending_runtime'].includes(status) ? status : null,
          countable: !['planned', 'pending_runtime'].includes(status) && !isClaudeToolRole,
          role: clean(sub?.role || sub?.description || sub?.type),
        });
      }
    }

    if (hasAgents) {
      for (const agent of bot.agents) {
        rows.push({
          source: 'registry',
          team: canonicalTeam,
          namespace: id,
          agent: clean(agent),
          kind: 'pending_runtime',
          status,
          selectorKey: null,
          primary: topModel,
          fallbacks: topFallbacks,
          modelStatus: topModel ? 'registry_model_only' : 'missing_model',
          blockReason: 'pending_runtime',
          countable: false,
          role: 'pending runtime agent',
        });
      }
    }
  }

  return rows;
}

function mergeInventory(selectorRows: any[], registryOnlyRows: any[]): any[] {
  const selectorIndex = new Map(selectorRows.map((row) => [`${row.team}.${row.agent}`, row]));
  const rows = [...selectorRows];
  for (const registryRow of registryOnlyRows) {
    const key = `${registryRow.team}.${registryRow.agent}`;
    const selectorRow = selectorIndex.get(key);
    if (selectorRow) {
      selectorRow.registryStatus = registryRow.status;
      selectorRow.registryModel = registryRow.primary || null;
      selectorRow.registryFallbacks = registryRow.fallbacks || [];
      selectorRow.role = registryRow.role || selectorRow.role || '';
      continue;
    }
    rows.push(registryRow);
  }
  return rows.sort((a, b) => (
    `${a.team}.${a.kind}.${a.agent}.${a.source}`.localeCompare(`${b.team}.${b.kind}.${b.agent}.${b.source}`)
  ));
}

function summarize(rows: any[], routeTargets: any[]): any {
  const countsByKind: Record<string, number> = {};
  const countsByModelStatus: Record<string, number> = {};
  const primaryProviderCounts: Record<string, number> = {};
  const chainProviderCounts: Record<string, number> = {};
  const claudeCodePrimaryRoutes = [];
  const claudeCodeFallbackRoutes = [];
  const missingModelAgents = [];

  for (const target of routeTargets) addCount(countsByKind, clean(target?.kind) || 'unknown');

  for (const row of rows) {
    addCount(countsByModelStatus, row.modelStatus || 'unknown');
    const providerEligible = !row.blockReason && !['team_container', 'non_llm_role', 'non_llm_service'].includes(row.modelStatus);
    const primaryProvider = providerOf(row.primary);
    if (providerEligible && row.primary) addCount(primaryProviderCounts, primaryProvider);
    const providers = [primaryProvider, ...(row.fallbacks || []).map(providerOf)].filter((provider) => provider !== 'missing');
    if (providerEligible) {
      for (const provider of providers) addCount(chainProviderCounts, provider);
    }
    if (primaryProvider === 'claude-code' && !row.blockReason) claudeCodePrimaryRoutes.push(row);
    if ((row.fallbacks || []).some((fallback: string) => providerOf(fallback) === 'claude-code') && !row.blockReason) {
      claudeCodeFallbackRoutes.push(row);
    }
    if (!row.primary && !row.blockReason && !['team_container', 'non_llm_role', 'non_llm_service'].includes(row.modelStatus)) {
      missingModelAgents.push(row);
    }
  }

  return {
    selectorRouteTargets: routeTargets.length,
    activeTargets: routeTargets.filter((target: any) => ['visible_agent', 'runtime_service'].includes(target?.kind) && !target?.blockReason).length,
    visibleAgents: routeTargets.filter((target: any) => target?.kind === 'visible_agent' && !target?.blockReason).length,
    runtimeServices: routeTargets.filter((target: any) => target?.kind === 'runtime_service' && !target?.blockReason).length,
    taskRoutes: routeTargets.filter((target: any) => target?.kind === 'task_route').length,
    aliases: routeTargets.filter((target: any) => target?.kind === 'alias').length,
    planned: rows.filter((row) => row.kind === 'planned' || row.status === 'planned').length,
    pendingRuntime: rows.filter((row) => row.kind === 'pending_runtime' || row.status === 'pending_runtime').length,
    retired: rows.filter((row) => row.kind === 'retired').length,
    countsByKind,
    countsByModelStatus,
    primaryProviderCounts,
    chainProviderCounts,
    claudeCodePrimaryRoutes: claudeCodePrimaryRoutes.map(compactRoute),
    claudeCodeFallbackRoutes: claudeCodeFallbackRoutes.map(compactRoute),
    missingModelAgents: missingModelAgents.map(compactRoute),
  };
}

function compactRoute(row: any): any {
  return {
    team: row.team,
    agent: row.agent,
    kind: row.kind,
    status: row.status,
    selectorKey: row.selectorKey,
    primary: row.primary || null,
    fallbacks: row.fallbacks || [],
    modelStatus: row.modelStatus,
  };
}

function recommendations(summary: any): string[] {
  const list = [];
  if (summary.claudeCodePrimaryRoutes.length > 0) {
    list.push('active claude-code primary routes remain; replace with openai-oauth/gpt-5.4 or gemini-cli-oauth/gemini-2.5-flash');
  }
  if (summary.claudeCodeFallbackRoutes.length > 0) {
    list.push('claude-code fallback routes remain; keep only behind LLM_CLAUDE_CODE_* quota guard or replace with OpenAI/Gemini fallback');
  }
  if (summary.missingModelAgents.length > 0) {
    list.push('active registry agents without selector/model need explicit selector keys or non-LLM classification');
  }
  list.push('planned/pending_runtime teams must remain blocked until runtime source and selector ownership exist');
  list.push('use LLM_CLAUDE_CODE_QUOTA_MODE=avoid or LLM_CLAUDE_CODE_DISABLED=true to shift legacy Claude Code usage to OpenAI OAuth during quota saturation');
  return list;
}

function markdown(report: any): string {
  const rows = report.rows;
  const activeRows = rows.filter((row: any) => !row.blockReason && row.kind !== 'task_route').slice(0, 120);
  const missingRows = report.summary.missingModelAgents;
  const claudeRows = [...report.summary.claudeCodePrimaryRoutes, ...report.summary.claudeCodeFallbackRoutes];

  function table(items: any[]): string {
    if (items.length === 0) return '_없음_';
    return [
      '| team | agent | kind | status | selector | primary | fallback | model_status |',
      '|---|---|---|---|---|---|---|---|',
      ...items.map((row: any) => `| ${row.team} | ${row.agent} | ${row.kind} | ${row.status || ''} | ${row.selectorKey || ''} | ${row.primary || ''} | ${(row.fallbacks || []).join('<br>')} | ${row.modelStatus || ''} |`),
    ].join('\n');
  }

  return `# LLM Agent Model Inventory

Generated at: ${report.generatedAt}

## Summary
- Selector route targets: ${report.summary.selectorRouteTargets}
- Active visible agents: ${report.summary.visibleAgents}
- Active runtime services: ${report.summary.runtimeServices}
- Task routes: ${report.summary.taskRoutes}
- Alias routes: ${report.summary.aliases}
- Planned rows: ${report.summary.planned}
- Pending runtime rows: ${report.summary.pendingRuntime}

## Primary Providers
\`\`\`json
${JSON.stringify(report.summary.primaryProviderCounts, null, 2)}
\`\`\`

## Claude Code Routes
${table(claudeRows)}

## Missing Active Model Rows
${table(missingRows)}

## Active Agent And Runtime Rows
${table(activeRows)}

## Recommendations
${report.recommendations.map((item: string) => `- ${item}`).join('\n')}
`;
}

function main(): void {
  const routeTargets = selector.listLlmRouteTargets({ includeInternal: true, includeAliases: true, includeBlocked: true });
  const selectorRows = routeTargets.map(rowFromTarget);
  const rows = mergeInventory(selectorRows, registryRows());
  const summary = summarize(rows, routeTargets);
  const report = {
    ok: summary.claudeCodePrimaryRoutes.length === 0,
    generatedAt: new Date().toISOString(),
    selectorVersion: SELECTOR_OPTIONS.selectorVersion,
    summary,
    recommendations: recommendations(summary),
    rows,
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT_MD), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(OUTPUT_MD, markdown(report));
  console.log(JSON.stringify({
    ok: report.ok,
    outputJson: OUTPUT_JSON,
    outputMd: OUTPUT_MD,
    summary,
  }, null, 2));
  if (!report.ok) process.exit(1);
}

try {
  main();
} catch (error: any) {
  console.error('[llm-agent-model-inventory-report] failed:', error?.message || error);
  process.exit(1);
}
