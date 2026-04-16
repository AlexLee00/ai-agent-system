// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureSystemPreferencesTable,
  getSelectorOverrideSuggestionLogById,
  updateSelectorOverrideSuggestionLogReview,
} = require(path.join(__dirname, '../bots/worker/lib/llm-api-monitoring'));

function parseArgs(argv = process.argv.slice(2)) {
  return {
    id: argv.find((arg) => arg.startsWith('--id='))?.split('=')[1] || null,
    configPath: argv.find((arg) => arg.startsWith('--config='))?.split('=')[1] || null,
    note: argv.find((arg) => arg.startsWith('--note='))?.split('=')[1] || null,
    json: argv.includes('--json'),
    write: argv.includes('--write'),
    force: argv.includes('--force'),
  };
}

function getByPath(target, pathParts) {
  return pathParts.reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), target);
}

function setByPath(target, pathParts, value) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = pathParts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

function cloneChain(chain = []) {
  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.temperature != null ? { temperature: entry.temperature } : {}),
  }));
}

function buildProviderModels(chain = []) {
  return chain.reduce((acc, entry) => {
    if (entry?.provider && entry?.model) {
      acc[entry.provider] = entry.model;
    }
    return acc;
  }, {});
}

function buildAppliedValue(row, currentValue) {
  const chain = cloneChain(row.suggested_chain || []);
  const runtimePath = String(row.runtime_path || '');

  if (runtimePath.endsWith('.chain') || Array.isArray(currentValue)) {
    return chain;
  }
  if (runtimePath.endsWith('.providerModels') || (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue))) {
    return buildProviderModels(chain);
  }
  return chain[0]?.model || row.candidate_model || null;
}

function resolveConfigPath(row, overridePath = null) {
  if (overridePath) return overridePath;
  if (!row.config_path) {
    throw new Error('추천 이력에 config_path가 없습니다. 직접 `--config=`를 지정해야 합니다.');
  }
  return path.join(__dirname, '..', row.config_path);
}

function buildChangeSet(row, rawConfig) {
  const pathParts = String(row.runtime_path || '').split('.').filter(Boolean);
  if (!pathParts.length) {
    throw new Error('추천 이력에 runtime_path가 없습니다.');
  }
  const actualCurrent = getByPath(rawConfig, pathParts);
  const appliedValue = buildAppliedValue(row, actualCurrent);
  return {
    pathParts,
    actualCurrent,
    appliedValue,
  };
}

function printHuman(result) {
  const lines = [
    `🛠️ LLM selector override 추천 ${result.write ? '적용 결과' : '미리보기'}`,
    '',
    `- suggestion_id: ${result.id}`,
    `- selector: ${result.selectorKey}`,
    `- status: ${result.reviewStatus}`,
    `- config: ${result.configPath}`,
    `- runtime path: ${result.runtimePath}`,
    `- simulated: ${result.simulated ? 'yes' : 'no'}`,
  ];

  if (result.write) {
    lines.push(`- applied_at: ${result.appliedAt || '-'}`);
  }

  lines.push('');
  lines.push('변경 내용:');
  lines.push(`- current: ${JSON.stringify(result.actualCurrent)}`);
  lines.push(`- suggested: ${JSON.stringify(result.appliedValue)}`);
  if (result.note) {
    lines.push(`- note: ${result.note}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { id, configPath, note, json, write, force } = parseArgs();
  if (!id) {
    throw new Error('`--id=<selector_override_suggestion_id>`가 필요합니다.');
  }

  await ensureSystemPreferencesTable();
  const row = await getSelectorOverrideSuggestionLogById(id);
  if (!row) {
    throw new Error(`selector override 추천 이력을 찾을 수 없습니다: ${id}`);
  }
  if (write && row.review_status !== 'approved' && !force) {
    throw new Error(`현재 상태가 ${row.review_status} 입니다. 실제 반영은 approved 상태에서만 가능합니다. 필요하면 --force를 사용하세요.`);
  }

  const resolvedConfigPath = resolveConfigPath(row, configPath);
  const rawConfig = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  const { pathParts, actualCurrent, appliedValue } = buildChangeSet(row, rawConfig);

  const isDefaultTarget = !configPath;
  const result = {
    id: row.id,
    selectorKey: row.selector_key,
    reviewStatus: row.review_status,
    configPath: resolvedConfigPath,
    runtimePath: row.runtime_path,
    simulated: !isDefaultTarget,
    write,
    actualCurrent,
    appliedValue,
    note: note || null,
    appliedAt: row.applied_at || null,
  };

  if (write) {
    setByPath(rawConfig, pathParts, appliedValue);
    fs.writeFileSync(resolvedConfigPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf8');

    if (isDefaultTarget) {
      const appendedNote = [row.review_note, note, `applied_selector=${row.selector_key}`]
        .filter(Boolean)
        .join(' | ');
      const updated = await updateSelectorOverrideSuggestionLogReview(row.id, {
        reviewStatus: 'applied',
        reviewNote: appendedNote,
      });
      result.reviewStatus = updated?.review_status || 'applied';
      result.appliedAt = updated?.applied_at || null;
      result.note = updated?.review_note || appendedNote || null;
      result.simulated = false;
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printHuman(result);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildAppliedValue,
  buildProviderModels,
  buildChangeSet,
};
