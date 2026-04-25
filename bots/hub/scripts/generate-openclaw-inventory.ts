const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, 'generate-hub-alarm-inventory.ts');
const result = spawnSync('tsx', [scriptPath], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(Number(result.status ?? 1));
