// @ts-nocheck
/**
 * registry.js - 봇 레지스트리 로더
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_FILE = path.join(ROOT, 'bots', 'registry.json');

function formatModelLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const lowered = text.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null' || lowered === 'nan') return '-';
  return text;
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
}

function getBot(registry, botId) {
  const bot = registry.bots[botId];
  if (!bot) {
    throw new Error(`봇 없음: ${botId} (등록된 봇: ${Object.keys(registry.bots).join(', ')})`);
  }
  return bot;
}

function listBots(registry) {
  log('\n📋 등록된 봇 목록:\n');
  for (const [id, bot] of Object.entries(registry.bots)) {
    const emoji = { ops: '✅', dev: '🔧', planned: '⏳' }[bot.status] || '❓';
    const targets = bot.deployTargets.map(t => t.type).join(', ') || '없음';
    console.log(`  ${emoji} ${id.padEnd(14)} ${bot.name.padEnd(20)} [${bot.status}] → ${targets}`);
    console.log(`     ${bot.description}`);
    console.log(`     모델: ${formatModelLabel(bot.model?.primary)}`);
    console.log('');
  }
}

module.exports = { loadRegistry, getBot, listBots };
