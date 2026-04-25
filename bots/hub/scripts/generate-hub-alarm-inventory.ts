const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const outputDir = path.join(projectRoot, 'bots', 'hub', 'output');
const outputJsonPath = path.join(outputDir, 'hub-alarm-dependency-inventory.json');
const outputMarkdownPath = path.join(projectRoot, 'docs', 'hub', 'HUB_ALARM_DEPENDENCY_INVENTORY.md');

const scanPatterns = [
  'hub-alarm-client',
  'openclaw-client',
  'HUB_ALARM_',
  'OPENCLAW_',
];

function classifyMatch(match) {
  if (match.includes('hub-alarm-client') || match.includes('HUB_ALARM_')) return 'hub_alarm_native';
  if (match.includes('openclaw-client') || match.includes('OPENCLAW_')) return 'legacy_openclaw_compat';
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
    '!docs/hub/OPENCLAW_CLIENT_INVENTORY.md',
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
      category: classifyMatch(match),
      match,
    });
  }
  return rows;
}

function countByCategory(rows) {
  return rows.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});
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
    generated_at: new Date().toISOString(),
    scan_patterns: scanPatterns,
    total_matches: rows.length,
    unique_files: Object.keys(grouped).length,
    categories: countByCategory(rows),
    files: grouped,
  };
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const markdown = [
    '# Hub Alarm Dependency Inventory',
    '',
    'This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `legacy_openclaw_compat` entries are compatibility shims or remaining migration targets.',
    '',
    `- generated_at: ${payload.generated_at}`,
    `- total_matches: ${payload.total_matches}`,
    `- unique_files: ${payload.unique_files}`,
    `- hub_alarm_native: ${payload.categories.hub_alarm_native || 0}`,
    `- legacy_openclaw_compat: ${payload.categories.legacy_openclaw_compat || 0}`,
    '',
    '## Files',
    '',
    ...Object.keys(grouped).sort().map((file) => {
      const entries = grouped[file];
      const lines = entries
        .sort((a, b) => (a.line || 0) - (b.line || 0))
        .map((entry) => `- L${entry.line || '?'} [${entry.category}]: \`${entry.match}\``);
      return [`### \`${file}\``, ...lines, ''].join('\n');
    }),
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
