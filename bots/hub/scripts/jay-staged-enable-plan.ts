#!/usr/bin/env tsx
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function isEnabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function textEnv(name) {
  return String(process.env[name] || '').trim();
}

function launchctlEnv(name) {
  const result = spawnSync('launchctl', ['getenv', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (Number(result.status) !== 0) return '';
  return String(result.stdout || '').trim();
}

function loadHubSecrets() {
  const storePath = path.resolve(__dirname, '..', 'secrets-store.json');
  try {
    if (!fs.existsSync(storePath)) return {};
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return {};
  }
}

function launchdPlistEnv(name) {
  const plistPath = path.resolve(__dirname, '..', '..', 'orchestrator', 'launchd', 'ai.jay.runtime.plist');
  try {
    if (!fs.existsSync(plistPath)) return '';
    const plist = fs.readFileSync(plistPath, 'utf8');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = plist.match(new RegExp(`<key>${escaped}<\\/key>\\s*<string>([^<]*)<\\/string>`));
    return match ? String(match[1] || '').trim() : '';
  } catch {
    return '';
  }
}

function storeValue(name, store) {
  const telegram = store?.telegram || {};
  const topicIds = telegram.topic_ids || telegram.telegram_topic_ids || {};
  if (name === 'TELEGRAM_GROUP_ID') return telegram.group_id || telegram.telegram_group_id || telegram.chat_id || telegram.telegram_chat_id || '';
  if (name === 'TELEGRAM_TOPIC_OPS_WORK') return topicIds.ops_work || '';
  if (name === 'TELEGRAM_TOPIC_OPS_REPORTS') return topicIds.ops_reports || '';
  if (name === 'TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION') return topicIds.ops_error_resolution || '';
  if (name === 'HUB_CONTROL_APPROVAL_CHAT_ID') return telegram.group_id || telegram.telegram_group_id || telegram.chat_id || telegram.telegram_chat_id || '';
  if (name === 'HUB_CONTROL_APPROVAL_TOPIC_ID') return topicIds.ops_error_resolution || '';
  return '';
}

let _store = null;
function runtimeValue(name) {
  if (!_store) _store = loadHubSecrets();
  return textEnv(name) || launchctlEnv(name) || String(storeValue(name, _store) || '').trim() || launchdPlistEnv(name);
}

function runtimeBool(config, key, envName) {
  const envValue = runtimeValue(envName);
  if (envValue) return isEnabled(envValue);
  return config?.[key] === true;
}

function stage(input) {
  return input;
}

async function main() {
  const json = process.argv.includes('--json');
  const runtimeConfig = require('../../orchestrator/lib/runtime-config.ts');
  const config = runtimeConfig.getJayOrchestrationConfig();
  const commanderRegistry = require('../../orchestrator/lib/commanders/index.ts');
  const adapterModes = Object.fromEntries(['luna', 'blog', 'ska'].map((team) => {
    const adapter = commanderRegistry.getCommanderAdapter(team);
    return [team, adapter?.mode || 'missing'];
  }));

  const stages = [
    stage({
      id: 1,
      name: 'Incident Store',
      ready: runtimeBool(config, 'incidentStoreEnabled', 'JAY_INCIDENT_STORE_ENABLED'),
      enable: ['JAY_INCIDENT_STORE_ENABLED=1'],
      verify: ['npm --prefix bots/hub run -s jay:status -- --json'],
      note: 'Jay가 오류/요청을 dedupe 가능한 incident로 영속화합니다.',
    }),
    stage({
      id: 2,
      name: 'Hub Planner',
      ready: runtimeBool(config, 'hubPlanIntegration', 'JAY_HUB_PLAN_INTEGRATION'),
      enable: ['JAY_HUB_PLAN_INTEGRATION=1', 'HUB_AUTH_TOKEN=<runtime secret>'],
      verify: ['npx tsx bots/hub/scripts/jay-control-plan-integration-smoke.ts'],
      note: 'intent 분기가 아니라 Hub control planner가 계획 초안을 만듭니다.',
    }),
    stage({
      id: 3,
      name: '3-Tier Telegram Meeting',
      ready: runtimeBool(config, 'threeTierTelegram', 'JAY_3TIER_TELEGRAM')
        && Boolean(runtimeValue('TELEGRAM_GROUP_ID'))
        && Boolean(runtimeValue('TELEGRAM_TOPIC_OPS_WORK'))
        && Boolean(runtimeValue('TELEGRAM_TOPIC_OPS_REPORTS'))
        && Boolean(runtimeValue('TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION')),
      enable: [
        'JAY_3TIER_TELEGRAM=1',
        'TELEGRAM_GROUP_ID=<supergroup id>',
        'TELEGRAM_TOPIC_OPS_WORK=<실무 알림 topic>',
        'TELEGRAM_TOPIC_OPS_REPORTS=<레포트 알림 topic>',
        'TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION=<오류 해결 topic>',
      ],
      verify: ['npm --prefix bots/hub run -s jay:telegram-meeting-dry-run'],
      note: '오류는 먼저 에이전트 회의/해결 흐름으로 들어가고, 사람에게는 요약만 갑니다.',
    }),
    stage({
      id: 4,
      name: 'Commander Dispatch',
      ready: runtimeBool(config, 'commanderEnabled', 'JAY_COMMANDER_ENABLED')
        && runtimeBool(config, 'commanderDispatch', 'JAY_COMMANDER_DISPATCH')
        && runtimeBool(config, 'teamBusEnabled', 'JAY_TEAM_BUS_ENABLED')
        && Object.values(adapterModes).every((mode) => mode === 'bot_command'),
      enable: [
        'JAY_COMMANDER_ENABLED=1',
        'JAY_COMMANDER_DISPATCH=1',
        'JAY_TEAM_BUS_ENABLED=1',
        'JAY_COMMANDER_BOT_QUEUE_ENABLED=1',
      ],
      verify: ['npx tsx bots/hub/scripts/jay-commander-bot-command-smoke.ts'],
      note: 'Luna/Blog/Ska가 virtual adapter를 벗어나 bot_commands 큐 기반으로 연결됩니다.',
    }),
    stage({
      id: 5,
      name: 'Skill Memory',
      ready: runtimeBool(config, 'skillExtraction', 'JAY_SKILL_EXTRACTION'),
      enable: ['JAY_SKILL_EXTRACTION=1'],
      verify: ['npx tsx bots/hub/scripts/jay-skill-extraction-smoke.ts', 'npx tsx bots/hub/scripts/jay-skill-reuse-smoke.ts'],
      note: '해결 사례를 reusable skill로 저장해 다음 incident 계획에 붙입니다.',
    }),
    stage({
      id: 6,
      name: 'Runtime Cutover Gate',
      ready: Boolean(runtimeValue('HUB_CONTROL_CALLBACK_SECRET'))
        && Boolean(runtimeValue('HUB_CONTROL_APPROVER_IDS') || runtimeValue('HUB_CONTROL_APPROVER_USERNAMES'))
        && Boolean(runtimeValue('HUB_CONTROL_APPROVAL_TOPIC_ID'))
        && Boolean(runtimeValue('HUB_CONTROL_APPROVAL_CHAT_ID')),
      enable: [
        'HUB_CONTROL_CALLBACK_SECRET=<non-placeholder secret>',
        'HUB_CONTROL_APPROVER_IDS=<Telegram user id>',
        'HUB_CONTROL_APPROVAL_TOPIC_ID=<approval topic>',
        'HUB_CONTROL_APPROVAL_CHAT_ID=<Telegram group>',
      ],
      verify: ['npm --prefix bots/hub run -s check:runtime'],
      note: 'mutating approval, callback trust boundary, launchd/runtime secret wiring을 확인합니다.',
    }),
  ];

  const payload = {
    ok: true,
    adapterModes,
    readyCount: stages.filter((item) => item.ready).length,
    total: stages.length,
    stages,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Jay staged enable plan (${payload.readyCount}/${payload.total} ready)`);
  for (const item of stages) {
    console.log(`\n${item.id}. ${item.ready ? '[ready]' : '[pending]'} ${item.name}`);
    console.log(`   note: ${item.note}`);
    console.log(`   enable: ${item.enable.join(' ; ')}`);
    console.log(`   verify: ${item.verify.join(' ; ')}`);
  }
}

main().catch((error) => {
  console.error(`jay_staged_enable_plan_failed: ${error?.message || error}`);
  process.exit(1);
});
