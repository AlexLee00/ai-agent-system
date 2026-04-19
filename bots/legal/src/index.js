'use strict';

/**
 * src/index.js — 저스틴팀 진입점
 *
 * 서비스 시작 또는 CLI 명령 진입점.
 * 실제 오케스트레이션 로직은 lib/justin.js 에 있음.
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const justin = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/justin'));

if (require.main === module) {
  const command = process.argv[2];

  if (command === 'status') {
    justin.getStatus().then(status => {
      console.log('[Justin] 상태:', JSON.stringify(status, null, 2));
    }).catch(err => {
      console.error('[Justin] 상태 조회 실패:', err.message);
      process.exit(1);
    });
  } else {
    console.log('[Justin] 저스틴팀 감정 자동화 시스템');
    console.log('사용법:');
    console.log('  node src/index.js status     — 현재 진행 중 사건 현황');
    console.log('  node scripts/start-appraisal.js  — 감정 시작');
    console.log('  node scripts/health-check.js     — 헬스 체크');
  }
}

module.exports = justin;
