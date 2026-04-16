// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const LUNA_UPDATES = [
  { name: 'luna', specialty: '펀드매니저(팀장)', role: 'leader' },
  { name: 'aria', specialty: '단기시그널분석(5분~1시간)', role: 'analyst' },
  { name: 'oracle', specialty: '장기트렌드분석(일봉~주봉)', role: 'analyst' },
  { name: 'sentinel', specialty: '외부정보감시(뉴스+커뮤니티감성)', role: 'analyst' },
  { name: 'chronos', specialty: '백테스팅+전략검증(VectorBT)', role: 'analyst' },
  { name: 'nemesis', specialty: '리스크관리(하드룰+예산+적응형)', role: 'risk' },
  { name: 'zeus', specialty: '암호화폐주문실행(바이낸스)', role: 'executor' },
  { name: 'athena', specialty: '주식주문실행(한투/미래)', role: 'executor' },
];

async function main() {
  console.log(`🔄 루나팀 역할 명확화 (${LUNA_UPDATES.length}건)...`);

  for (const update of LUNA_UPDATES) {
    try {
      await pgPool.run(
        'agent',
        `UPDATE agent.registry
         SET specialty = $1, role = $2, updated_at = NOW()
         WHERE name = $3`,
        [update.specialty, update.role, update.name],
      );
      console.log(`  ✅ ${update.name} → ${update.specialty}`);
    } catch (error) {
      console.error(`  ❌ ${update.name}: ${error.message}`);
    }
  }

  console.log('🔄 완료');
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
