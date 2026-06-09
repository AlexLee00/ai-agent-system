import { spawnSync } from 'node:child_process';
import path from 'node:path';

const hubRoot = path.resolve(__dirname, '..');
const result = spawnSync(
  process.execPath,
  [
    '--disable-warning=DEP0205',
    '--import',
    'tsx',
    '-e',
    "console.log('node26_tsx_deprecation_warning_smoke_ok')",
  ],
  {
    cwd: hubRoot,
    encoding: 'utf8',
  },
);

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'tsx import smoke failed without output');
  process.exit(Number(result.status || 1));
}

if ((result.stderr || '').includes('DEP0205') || (result.stderr || '').includes('module.register() is deprecated')) {
  console.error(result.stderr);
  process.exit(1);
}

if (!(result.stdout || '').includes('node26_tsx_deprecation_warning_smoke_ok')) {
  console.error(result.stdout || 'tsx import smoke did not print success marker');
  process.exit(1);
}

console.log('node26_tsx_deprecation_warning_smoke_ok');
