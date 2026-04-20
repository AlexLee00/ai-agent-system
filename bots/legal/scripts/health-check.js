'use strict';

/**
 * health-check.js — 저스틴팀 헬스 체크
 *
 * 사용: node scripts/health-check.js
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { resolveKoreaLawCredentials } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/legal-credentials'));

async function main() {
  console.log('[Justin] 헬스 체크 시작...');

  const checks = [];

  // 1. DB 연결 + legal 스키마 확인
  try {
    const cases = await store.listCases({ limit: 1 });
    checks.push({ name: 'DB legal.cases', ok: true, detail: `rows ok` });
  } catch (err) {
    checks.push({ name: 'DB legal.cases', ok: false, detail: err.message });
  }

  // 2. 에이전트 모듈 로드 가능 여부
  const agents = ['justin', 'briefing', 'lens', 'garam', 'atlas', 'claim', 'defense', 'quill', 'balance', 'contro'];
  for (const agent of agents) {
    try {
      require(path.join(env.PROJECT_ROOT, `bots/legal/lib/${agent}`));
      checks.push({ name: `module:${agent}`, ok: true });
    } catch (err) {
      checks.push({ name: `module:${agent}`, ok: false, detail: err.message });
    }
  }

  // 3. 템플릿 파일 존재 확인
  const fs = require('fs');
  const templates = ['appraisal-report.md', 'code-comparison-table.md'];
  for (const tpl of templates) {
    const filePath = path.join(env.PROJECT_ROOT, `bots/legal/templates/${tpl}`);
    const exists = fs.existsSync(filePath);
    checks.push({ name: `template:${tpl}`, ok: exists });
  }

  // 4. 국가법령정보 공동활용 인증값 존재 여부
  try {
    const creds = await resolveKoreaLawCredentials();
    const configured = Boolean(creds.userId && creds.userName && creds.oc);
    checks.push({
      name: 'korea-law-credentials',
      ok: true,
      detail: configured ? 'hub/local secrets configured' : 'not configured yet (optional until API client is enabled)',
    });
  } catch (err) {
    checks.push({ name: 'korea-law-credentials', ok: true, detail: `lookup skipped: ${err.message}` });
  }

  // 결과 출력
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    const detail = c.detail ? ` — ${c.detail}` : '';
    console.log(`  ${icon} ${c.name}${detail}`);
    if (!c.ok) allOk = false;
  }

  const passed = checks.filter(c => c.ok).length;
  console.log(`\n[Justin] 헬스 체크 완료: ${passed}/${checks.length} 통과`);

  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('[Justin] 헬스 체크 오류:', err.message);
  process.exit(1);
});
