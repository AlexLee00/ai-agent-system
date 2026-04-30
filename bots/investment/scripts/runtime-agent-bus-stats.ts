#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectAgentBusStats,
  renderAgentBusStatsMarkdown,
} from '../shared/agent-bus-stats.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runAgentBusStats({
  days = Number(argValue('days', 7)),
  write = process.argv.includes('--write'),
  outputDir = path.join(INVESTMENT_DIR, 'output', 'reports'),
} = {}) {
  const stats = await collectAgentBusStats({ days });
  const markdown = renderAgentBusStatsMarkdown(stats);
  let outputPath = null;
  if (write) {
    fs.mkdirSync(outputDir, { recursive: true });
    outputPath = path.join(outputDir, `luna-agent-bus-stats-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outputPath, markdown, 'utf8');
  }
  return { ok: true, days, stats, markdown, outputPath };
}

async function main() {
  const result = await runAgentBusStats();
  if (process.argv.includes('--json')) {
    const { markdown, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(result.markdown);
    if (result.outputPath) console.log(`\nwritten: ${result.outputPath}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ agent-bus-stats 실패:' });
}
