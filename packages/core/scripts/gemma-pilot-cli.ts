// @ts-nocheck
'use strict';

const { generateGemmaPilotText } = require('../lib/gemma-pilot');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value = ''] = arg.slice(2).split('=');
    out[key] = value;
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs();
  const prompt = (await readStdin()).trim();
  const result = await generateGemmaPilotText({
    team: args.team,
    purpose: args.purpose,
    bot: args.bot || args.team,
    requestType: args.requestType || 'gemma-pilot',
    prompt,
    maxTokens: args.maxTokens ? Number(args.maxTokens) : undefined,
    temperature: args.temperature ? Number(args.temperature) : undefined,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
  });
  if (result?.ok && result.content) process.stdout.write(result.content.trim());
}

main().catch(() => process.exit(0));
