// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const BOT_CONFIGS = [
  { id: 'academic', path: 'bots/academic/config.json' },
  { id: 'legal', path: 'bots/legal/config.json' },
  { id: 'data', path: 'bots/data/config.json' },
  { id: 'blog', path: 'bots/blog/config.json' },
  { id: 'worker', path: 'bots/worker/config.json' },
  { id: 'orchestrator', path: 'bots/orchestrator/config.json' },
  { id: 'investment', path: 'bots/investment/config.yaml' },
  { id: 'reservation', path: 'bots/reservation/config.yaml' },
  { id: 'claude', path: 'bots/claude/config.json' },
];

function parseYamlList(content, keyName) {
  const lines = content.split('\n');
  const items = [];
  let inBlock = false;

  for (const line of lines) {
    if (new RegExp(`^${keyName}:\\s*$`).test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const match = line.match(/^\s+-\s+([a-z0-9-/]+)/);
      if (match) {
        items.push(match[1]);
      } else if (/^\S/.test(line)) {
        break;
      }
    }
  }

  return items;
}

function readMcpsFromConfig(configPath) {
  const absPath = path.isAbsolute(configPath) ? configPath : path.join(ROOT, configPath);

  try {
    const content = fs.readFileSync(absPath, 'utf8');

    if (absPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed.mcps) ? parsed.mcps : [];
    }

    if (absPath.endsWith('.yaml') || absPath.endsWith('.yml')) {
      return parseYamlList(content, 'mcps');
    }
  } catch (error) {
    console.warn(`[mcp/loader] config 읽기 실패: ${configPath} — ${error.message}`);
  }

  return [];
}

function loadMcps(configPath) {
  const mcps = readMcpsFromConfig(configPath);
  return {
    loaded: mcps,
    failed: [],
  };
}

function getMcpUsers(mcpName) {
  const users = [];

  for (const bot of BOT_CONFIGS) {
    const mcps = readMcpsFromConfig(bot.path);
    if (mcps.includes(mcpName)) {
      users.push(bot.id);
    }
  }

  return users;
}

function getAllMappings() {
  const mappings = {};

  for (const bot of BOT_CONFIGS) {
    mappings[bot.id] = readMcpsFromConfig(bot.path);
  }

  return mappings;
}

module.exports = { loadMcps, readMcpsFromConfig, getMcpUsers, getAllMappings, BOT_CONFIGS };
