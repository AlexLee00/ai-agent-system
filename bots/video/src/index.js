'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, '..', 'config', 'video-config.yaml');

let config;
try {
  const configText = fs.readFileSync(configPath, 'utf8');
  config = yaml.load(configText);
  console.log('[video] config 로드 성공');
} catch (err) {
  console.error('[video] config 로드 실패:', err.message);
  process.exit(1);
}

const pgPool = require('../../../packages/core/lib/pg-pool');

async function testDB() {
  try {
    const rows = await pgPool.query('public', 'SELECT NOW() AS now');
    console.log('[video] DB 연결 성공:', rows[0].now);
  } catch (err) {
    console.error('[video] DB 연결 실패:', err.message);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('[video] 비디오팀 엔트리 시작');
  console.log(
    '[video] 렌더링 설정:',
    config.ffmpeg.render_bitrate,
    `${config.ffmpeg.render_width}x${config.ffmpeg.render_height}`
  );
  await testDB();
  console.log('[video] 초기화 완료');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[video] 초기화 실패:', err.message);
    process.exit(1);
  });
}

module.exports = { config, testDB, main };
