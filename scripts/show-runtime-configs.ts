// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const root = process.env.PROJECT_ROOT || path.join(os.homedir(), 'projects', 'ai-agent-system');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return null;
  }
}

function extractInvestmentRuntimeConfig(raw) {
  const marker = 'runtime_config:';
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;
  return raw.slice(idx).trim();
}

function main() {
  const investmentPath = path.join(root, 'bots/investment/config.yaml');
  const reservationPath = path.join(root, 'bots/reservation/config.yaml');
  const skaPath = path.join(root, 'bots/ska/config.json');
  const workerPath = path.join(root, 'bots/worker/config.json');
  const orchestratorPath = path.join(root, 'bots/orchestrator/config.json');
  const claudePath = path.join(root, 'bots/claude/config.json');
  const blogPath = path.join(root, 'bots/blog/config.json');

  const investmentRaw = readText(investmentPath);
  const reservationRaw = readText(reservationPath);
  const skaJson = readJson(skaPath);
  const workerJson = readJson(workerPath);
  const orchestratorJson = readJson(orchestratorPath);
  const claudeJson = readJson(claudePath);
  const blogJson = readJson(blogPath);

  const lines = [];
  lines.push('운영 설정 인덱스');
  lines.push('');
  lines.push(`[investment] ${investmentPath}`);
  lines.push(investmentRaw ? extractInvestmentRuntimeConfig(investmentRaw) || 'runtime_config 없음' : '파일 읽기 실패');
  lines.push('');
  lines.push(`[reservation] ${reservationPath}`);
  lines.push(reservationRaw || '파일 읽기 실패');
  lines.push('');
  lines.push(`[ska] ${skaPath}`);
  lines.push(JSON.stringify((skaJson && skaJson.runtime_config) || skaJson, null, 2));
  lines.push('');
  lines.push(`[worker] ${workerPath}`);
  lines.push(JSON.stringify((workerJson && workerJson.runtime_config) || workerJson, null, 2));
  lines.push('');
  lines.push(`[orchestrator] ${orchestratorPath}`);
  lines.push(JSON.stringify((orchestratorJson && orchestratorJson.runtime_config) || orchestratorJson, null, 2));
  lines.push('');
  lines.push(`[claude] ${claudePath}`);
  lines.push(JSON.stringify((claudeJson && claudeJson.runtime_config) || claudeJson, null, 2));
  lines.push('');
  lines.push(`[blog] ${blogPath}`);
  lines.push(JSON.stringify((blogJson && blogJson.runtime_config) || blogJson, null, 2));

  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
