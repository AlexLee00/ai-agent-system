#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/apply-runtime-config-suggestion.js
 *
 * 승인된 runtime_config 제안 스냅샷을 config.yaml에 반영하고,
 * 성공 시 suggestion_log 상태를 applied 로 갱신한다.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import * as db from '../shared/db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'config.yaml');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    id: argv.find(arg => arg.startsWith('--id='))?.split('=')[1] || null,
    configPath: argv.find(arg => arg.startsWith('--config='))?.split('=')[1] || DEFAULT_CONFIG_PATH,
    keys: (argv.find(arg => arg.startsWith('--keys='))?.split('=')[1] || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    note: argv.find(arg => arg.startsWith('--note='))?.split('=')[1] || null,
    json: argv.includes('--json'),
    write: argv.includes('--write'),
    force: argv.includes('--force'),
  };
}

function getByPath(target, path) {
  return path.reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), target);
}

function setByPath(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function toRuntimePath(key) {
  return String(key || '')
    .replace(/^runtime_config\./, '')
    .split('.')
    .filter(Boolean);
}

function buildChangeSet(row, selectedKeys = []) {
  const allowAll = selectedKeys.length === 0;
  return (row.suggestions || [])
    .filter(item => item.action === 'adjust')
    .filter(item => allowAll || selectedKeys.includes(item.key))
    .map(item => ({
      key: item.key,
      path: toRuntimePath(item.key),
      current: item.current,
      suggested: item.suggested,
      confidence: item.confidence,
      reason: item.reason,
    }));
}

function printHuman(result) {
  const lines = [
    `🛠️ 투자 runtime_config 제안 적용 ${result.write ? '결과' : '미리보기'}`,
    '',
    `- suggestion_log_id: ${result.id}`,
    `- review_status: ${result.reviewStatus}`,
    `- config: ${result.configPath}`,
  ];

  if (result.write) {
    lines.push(`- applied_at: ${result.appliedAt || '-'}`);
  }

  lines.push('');
  lines.push('적용 항목:');
  for (const change of result.changes) {
    lines.push(`- ${change.key}`);
    lines.push(`  current: ${change.actualCurrent}`);
    lines.push(`  suggested: ${change.suggested}`);
    lines.push(`  confidence: ${change.confidence}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { id, configPath, keys, note, json, write, force } = parseArgs();
  if (!id) {
    throw new Error('`--id=<suggestion_log_id>`가 필요합니다.');
  }

  await db.initSchema();
  const row = await db.getRuntimeConfigSuggestionLogById(id);
  if (!row) {
    throw new Error(`제안 이력을 찾을 수 없습니다: ${id}`);
  }
  if (write && row.review_status !== 'approved' && !force) {
    throw new Error(`현재 상태가 ${row.review_status} 입니다. 실제 반영은 approved 상태에서만 가능합니다. 필요하면 --force를 사용하세요.`);
  }

  const raw = yaml.load(readFileSync(configPath, 'utf8')) || {};
  const isDefaultConfigTarget = configPath === DEFAULT_CONFIG_PATH;
  if (!raw.runtime_config || typeof raw.runtime_config !== 'object') {
    raw.runtime_config = {};
  }

  const changes = buildChangeSet(row, keys).map(item => ({
    ...item,
    actualCurrent: getByPath(raw.runtime_config, item.path),
  }));

  if (!changes.length) {
    throw new Error('반영할 adjust 제안이 없습니다. `--keys` 선택이 너무 좁거나 저장된 제안이 모두 hold 상태일 수 있습니다.');
  }

  if (write) {
    for (const change of changes) {
      setByPath(raw.runtime_config, change.path, change.suggested);
    }
    writeFileSync(configPath, yaml.dump(raw, { lineWidth: 120, noRefs: true }), 'utf8');

    const result = {
      id,
      reviewStatus: row.review_status,
      appliedAt: row.applied_at || null,
      configPath,
      simulated: !isDefaultConfigTarget,
      write: true,
      changes,
    };

    if (isDefaultConfigTarget) {
      const appendedNote = [row.review_note, note, `applied_keys=${changes.map(item => item.key).join(',')}`]
        .filter(Boolean)
        .join(' | ');
      const updated = await db.updateRuntimeConfigSuggestionLogReview(id, {
        reviewStatus: 'applied',
        reviewNote: appendedNote,
      });
      result.reviewStatus = updated?.review_status || 'applied';
      result.appliedAt = updated?.applied_at || null;
    }

    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    printHuman(result);
    return;
  }

  const result = {
    id,
    reviewStatus: row.review_status,
    configPath,
    write: false,
    changes,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printHuman(result);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
