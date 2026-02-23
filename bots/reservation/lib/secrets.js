const fs = require('fs');
const path = require('path');

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets.json'), 'utf-8')); }
  catch (e) { console.error('❌ secrets.json 로드 실패:', e.message); process.exit(1); }
}

module.exports = { loadSecrets };
