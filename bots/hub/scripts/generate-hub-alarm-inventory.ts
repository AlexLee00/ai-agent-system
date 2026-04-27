const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const outputDir = path.join(projectRoot, 'bots', 'hub', 'output');
const outputJsonPath = path.join(outputDir, 'hub-alarm-dependency-inventory.json');
const outputMarkdownPath = path.join(projectRoot, 'docs', 'hub', 'HUB_ALARM_DEPENDENCY_INVENTORY.md');
const LEGACY_ALARM_CLIENT_PATTERN = 'open' + 'claw-client';
const RETIRED_ENV_PREFIX_PATTERN = 'OPEN' + 'CLAW_';
const RETIRED_GATEWAY_GUARD_FILES = [
  'bots/hub/scripts/hub-transition-completion-gate.ts',
  'bots/hub/scripts/generate-hub-alarm-inventory.ts',
  'bots/hub/scripts/retired-gateway-residue-audit.ts',
  'bots/hub/scripts/retired-gateway-cutover-readiness.ts',
  'bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts',
  'bots/hub/scripts/runtime-env-policy-smoke.ts',
  'packages/core/lib/runtime-env-policy.ts',
  'scripts/pre-commit',
];

const scanPatterns = [
  'hub-alarm-client',
  LEGACY_ALARM_CLIENT_PATTERN,
  'HUB_ALARM_',
  RETIRED_ENV_PREFIX_PATTERN,
];

function isRetiredGatewayGuard(file) {
  return RETIRED_GATEWAY_GUARD_FILES.includes(String(file || ''));
}

function classifyMatch(file, match) {
  if (match.includes('hub-alarm-client') || match.includes('HUB_ALARM_')) return 'hub_alarm_native';
  if (isRetiredGatewayGuard(file) && (match.includes(LEGACY_ALARM_CLIENT_PATTERN) || match.includes(RETIRED_ENV_PREFIX_PATTERN))) {
    return 'retired_gateway_guard';
  }
  if (match.includes(LEGACY_ALARM_CLIENT_PATTERN)) return 'legacy_gateway_compat';
  if (match.includes(RETIRED_ENV_PREFIX_PATTERN)) {
    return isRetiredGatewayGuard(file) ? 'retired_gateway_guard' : 'legacy_gateway_compat';
  }
  return 'other';
}

function runInventoryScan() {
  const patternArgs = scanPatterns.flatMap((pattern) => ['-e', pattern]);
  const result = spawnSync('rg', [
    '-n',
    '-S',
    ...patternArgs,
    '-g',
    '!**/node_modules/**',
    '-g',
    '!**/.git/**',
    '-g',
    '!**/dist/**',
    '-g',
    '!bots/hub/output/**',
    '-g',
    '!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',
    '-g',
    '!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',
    '-g',
    `!docs/hub/${'OPEN' + 'CLAW_CLIENT_INVENTORY.md'}`,
    '-g',
    '!**/*.log',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 && String(result.stdout || '').trim().length === 0) {
    throw new Error(result.stderr?.trim() || `rg failed with status=${result.status}`);
  }
  return String(result.stdout || '').trim().split('\n').filter(Boolean);
}

function parseRows(lines) {
  const rows = [];
  for (const line of lines) {
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon <= 0 || secondColon <= firstColon) continue;
    const file = line.slice(0, firstColon);
    const lineNo = Number(line.slice(firstColon + 1, secondColon));
    const match = line.slice(secondColon + 1).trim();
    rows.push({
      file,
      line: Number.isFinite(lineNo) ? lineNo : null,
      category: classifyMatch(file, match),
      match,
    });
  }
  return rows.sort((a, b) => {
    const fileCompare = String(a.file).localeCompare(String(b.file));
    if (fileCompare !== 0) return fileCompare;
    const lineCompare = Number(a.line || 0) - Number(b.line || 0);
    if (lineCompare !== 0) return lineCompare;
    return String(a.match).localeCompare(String(b.match));
  });
}

function countByCategory(rows) {
  const counts = rows.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});
  const result = {
    hub_alarm_native: counts.hub_alarm_native || 0,
    retired_gateway_guard: counts.retired_gateway_guard || 0,
    legacy_gateway_compat: counts.legacy_gateway_compat || 0,
  };
  if (counts.other) result.other = counts.other;
  return result;
}

function stripGeneratedAt(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.generated_at;
  return clone;
}

function readPreviousGeneratedAt(nextPayload) {
  if (!fs.existsSync(outputJsonPath)) return '';
  try {
    const previous = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));
    const previousComparable = stripGeneratedAt(previous);
    const nextComparable = stripGeneratedAt(nextPayload);
    if (JSON.stringify(previousComparable) === JSON.stringify(nextComparable)) {
      return String(previous.generated_at || '');
    }
  } catch {
    return '';
  }
  return '';
}

function writeOutputs(rows) {
  fs.mkdirSync(outputDir, { recursive: true });
  const grouped = rows.reduce((acc, row) => {
    const key = row.file;
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});

  const payload = {
    generated_at: '',
    scan_patterns: scanPatterns,
    total_matches: rows.length,
    unique_files: Object.keys(grouped).length,
    categories: countByCategory(rows),
    files: grouped,
  };
  if ((payload.categories.legacy_gateway_compat || 0) > 0) {
    const offenders = rows
      .filter((row) => row.category === 'legacy_gateway_compat')
      .map((row) => `${row.file}:${row.line || '?'} ${row.match}`)
      .slice(0, 10)
      .join('\n');
    throw new Error(`legacy gateway compat references remain:\n${offenders}`);
  }
  payload.generated_at = readPreviousGeneratedAt(payload) || new Date().toISOString();
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const fileSections = Object.keys(grouped).sort().map((file) => {
    const entries = grouped[file];
    const lines = entries
      .sort((a, b) => (a.line || 0) - (b.line || 0))
      .map((entry) => `- L${entry.line || '?'} [${entry.category}]: \`${entry.match}\``);
    return [`### \`${file}\``, ...lines].join('\n');
  });

  const markdown = [
    '# Hub Alarm Dependency Inventory',
    '',
    'This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `retired_gateway_guard` entries are regression guards; `legacy_gateway_compat` entries are remaining migration targets and must stay at 0.',
    '',
    `- generated_at: ${payload.generated_at}`,
    `- total_matches: ${payload.total_matches}`,
    `- unique_files: ${payload.unique_files}`,
    `- hub_alarm_native: ${payload.categories.hub_alarm_native || 0}`,
    `- retired_gateway_guard: ${payload.categories.retired_gateway_guard || 0}`,
    `- legacy_gateway_compat: ${payload.categories.legacy_gateway_compat || 0}`,
    '',
    '## Files',
    '',
    fileSections.join('\n\n'),
  ].join('\n');
  fs.writeFileSync(outputMarkdownPath, `${markdown}\n`, 'utf8');
}

function main() {
  const lines = runInventoryScan();
  const rows = parseRows(lines);
  writeOutputs(rows);
  console.log(JSON.stringify({
    ok: true,
    total_matches: rows.length,
    unique_files: new Set(rows.map((row) => row.file)).size,
    categories: countByCategory(rows),
    output_json: outputJsonPath,
    output_markdown: outputMarkdownPath,
  }, null, 2));
}

main();
