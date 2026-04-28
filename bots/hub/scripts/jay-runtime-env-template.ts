#!/usr/bin/env tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(prefix, fallback = '') {
  const match = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : fallback;
}

function template() {
  return [
    '# Jay runtime local env',
    '# Fill this file locally, keep it out of git, then run:',
    '# npm --prefix bots/hub run -s jay:runtime-env-install -- --env-file=/absolute/path/to/jay-runtime.env',
    '#',
    '# Secrets: use real non-placeholder values.',
    'HUB_AUTH_TOKEN=',
    'HUB_CONTROL_CALLBACK_SECRET=',
    '# Telegram approval gate. These may be short numeric IDs.',
    'HUB_CONTROL_APPROVER_IDS=',
    'HUB_CONTROL_APPROVAL_TOPIC_ID=',
    'HUB_CONTROL_APPROVAL_CHAT_ID=',
    '# Telegram class-topic routing.',
    'TELEGRAM_GROUP_ID=',
    'TELEGRAM_TOPIC_OPS_WORK=',
    'TELEGRAM_TOPIC_OPS_REPORTS=',
    'TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION=',
    '',
  ].join('\n');
}

async function main() {
  const write = hasArg('--write');
  const target = argValue('--target', path.join(os.homedir(), '.ai-agent-system', 'secrets', 'jay-runtime.env.template'));
  const content = template();

  if (write) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, target, mode: '0600' }, null, 2));
    return;
  }

  process.stdout.write(content);
}

main().catch((error) => {
  console.error(`jay_runtime_env_template_failed: ${error?.message || error}`);
  process.exit(1);
});
