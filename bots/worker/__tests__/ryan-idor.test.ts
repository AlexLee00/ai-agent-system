// @ts-nocheck
'use strict';

const path = require('path');
const Module = require('module');

let pass = 0;
let fail = 0;

function assert(desc, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${desc}`);
    return;
  }
  fail++;
  console.error(`  ❌ ${desc}${detail ? `\n     ${detail}` : ''}`);
}

function loadRyanWithMock(pgPoolMock) {
  const target = path.join(__dirname, '../src/ryan.ts');
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (String(request).includes('packages/core/lib/pg-pool')) {
      return pgPoolMock;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(target);
  } finally {
    Module._load = originalLoad;
  }
}

console.log('\n[ SEC-018 ryan.ts IDOR protection ]');

(async () => {
  const blockedQueries = [];
  const blockedRuns = [];
  const blockedPgPool = {
    async get(_schema, sql, params) {
      blockedQueries.push({ sql, params });
      if (sql.includes('UPDATE worker.milestones AS m')) return null;
      if (sql.includes('COUNT(*) AS cnt')) return { cnt: 0 };
      return null;
    },
    async run(_schema, sql, params) {
      blockedRuns.push({ sql, params });
      return { rowCount: 0 };
    },
  };

  const blockedRyan = loadRyanWithMock(blockedPgPool);
  const blocked = await blockedRyan.handleCommand(100, '/milestone_done 55');
  assert(
    '타 회사 milestone은 접근 거부 메시지 반환',
    blocked === '❌ 마일스톤 ID 55 없음 (또는 접근 권한 없음)',
    `got=${blocked}`,
  );
  assert(
    '타 회사 milestone 차단 쿼리는 company_id 필터 포함',
    blockedQueries.some(q => q.sql.includes('p.company_id = $2') && q.params[1] === 100),
  );
  assert(
    '타 회사 milestone 차단 시 프로젝트 진행률 UPDATE 없음',
    blockedRuns.length === 0,
    `runCount=${blockedRuns.length}`,
  );

  const ownQueries = [];
  const ownRuns = [];
  const ownPgPool = {
    async get(_schema, sql, params) {
      ownQueries.push({ sql, params });
      if (sql.includes('UPDATE worker.milestones AS m')) {
        return { project_id: 7, title: '보안 패치' };
      }
      if (sql.includes("m.status='completed'")) return { cnt: 2 };
      if (sql.includes('COUNT(*) AS cnt')) return { cnt: 4 };
      return null;
    },
    async run(_schema, sql, params) {
      ownRuns.push({ sql, params });
      return { rowCount: 1 };
    },
  };

  const ownRyan = loadRyanWithMock(ownPgPool);
  const own = await ownRyan.handleCommand(200, '/milestone_done 81');
  assert(
    '자기 회사 milestone은 정상 완료',
    own === '✅ 마일스톤 완료: 보안 패치\n프로젝트 진행률: 50%',
    `got=${own}`,
  );
  assert(
    'recalcProgress는 project/company 이중 필터 COUNT 사용',
    ownQueries.filter(q => q.sql.includes('JOIN worker.projects')).length >= 2,
  );
  assert(
    'project progress UPDATE도 company_id 필터 포함',
    ownRuns.some(q => q.sql.includes('WHERE id=$2 AND company_id=$3') && q.params[2] === 200),
  );

  const missingRyan = loadRyanWithMock(blockedPgPool);
  const missing = await missingRyan.handleCommand(100, '/milestone_done nope');
  assert(
    '잘못된 milestone id는 사용법 반환',
    missing === '사용법: /milestone_done {마일스톤ID}',
    `got=${missing}`,
  );

  console.log(`\nSEC-018 결과: ✅ ${pass}건 통과 / ❌ ${fail}건 실패 / 총 ${pass + fail}건`);
  if (fail > 0) process.exit(1);
})();
