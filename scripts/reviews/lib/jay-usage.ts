// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(getAiAgentHome(), 'workspace');
}

const SESSION_DIR = process.env.JAY_SESSION_DIR || path.join(getAiAgentWorkspace(), 'jay-sessions');

function toKstDate(isoString) {
  const ts = new Date(isoString).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, Number(daysArg?.split('=')[1] || 14));
  return { days, json: argv.includes('--json') };
}

function shouldIncludeDate(kstDate, allowedDates) {
  return Boolean(kstDate && allowedDates.has(kstDate));
}

function buildAllowedDates(days) {
  const out = new Set();
  for (let i = 0; i < days; i += 1) {
    const now = Date.now() + 9 * 60 * 60 * 1000;
    const date = new Date(now - (i * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    out.add(date);
  }
  return out;
}

function emptyUsageRow() {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
}

function addUsage(target, usage = {}) {
  target.calls += 1;
  target.input += Number(usage.input || 0);
  target.output += Number(usage.output || 0);
  target.cacheRead += Number(usage.cacheRead || 0);
  target.cacheWrite += Number(usage.cacheWrite || 0);
  target.totalTokens += Number(usage.totalTokens || 0);
}

function collectJayUsage({ days = 14 } = {}) {
  const allowedDates = buildAllowedDates(days);
  const summary = {
    periodDays: days,
    total: emptyUsageRow(),
    byDate: {},
    byModel: {},
    fileCount: 0,
  };

  if (!fs.existsSync(SESSION_DIR)) {
    return summary;
  }

  const files = fs.readdirSync(SESSION_DIR)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => path.join(SESSION_DIR, name));

  for (const file of files) {
    summary.fileCount += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== 'message') continue;
      const message = row.message || {};
      if (message.role !== 'assistant') continue;
      const usage = message.usage;
      if (!usage) continue;

      const provider = message.provider || 'unknown';
      const model = message.model || 'unknown';
      const kstDate = toKstDate(row.timestamp || message.timestamp || null);
      if (!shouldIncludeDate(kstDate, allowedDates)) continue;

      if (!summary.byDate[kstDate]) summary.byDate[kstDate] = emptyUsageRow();
      const modelKey = `${provider}/${model}`;
      if (!summary.byModel[modelKey]) {
        summary.byModel[modelKey] = {
          provider,
          model,
          ...emptyUsageRow(),
        };
      }

      addUsage(summary.total, usage);
      addUsage(summary.byDate[kstDate], usage);
      addUsage(summary.byModel[modelKey], usage);
    }
  }

  return summary;
}

module.exports = {
  SESSION_DIR,
  parseArgs,
  collectJayUsage,
};
