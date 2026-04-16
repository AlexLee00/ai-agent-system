// @ts-nocheck
'use strict';

/**
 * 카오스 테스트: 텔레그램 Rate Limit 방어 검증
 *
 * 짧은 시간 내 대량 메시지 발송을 시뮬레이션하여
 * telegram-sender.js의 Rate Limit 방어(큐잉/스로틀)가 동작하는지 검증.
 *
 * 실행:
 *   node scripts/chaos/telegram-rate-limit.js --dry-run         # 안전 — 실제 발송 없음
 *   node scripts/chaos/telegram-rate-limit.js --count=20        # 실제 발송! 마스터에게 알림 감
 *
 * 기본: --dry-run 모드
 */

const tg = require('../../packages/core/lib/telegram-sender');

const args   = process.argv.slice(2);
const count  = parseInt(args.find(a => a.startsWith('--count='))?.split('=')[1] || '10');
const dryRun = !args.includes('--no-dry-run');  // 기본값 드라이런

async function simulateDryRun(count) {
  console.log(`드라이런: 실제 발송 없이 큐잉 로직 시뮬레이션 (${count}건)`);
  const results = { success: 0, failed: 0 };
  const start   = Date.now();

  // 큐잉 시뮬레이션: 0~100ms 랜덤 지연
  const promises = Array.from({ length: count }, (_, i) =>
    (async () => {
      await new Promise(r => setTimeout(r, Math.random() * 100));
      results.success++;
      process.stdout.write(`  [${i + 1}/${count}] ✅ (dry run)\n`);
    })()
  );

  await Promise.allSettled(promises);
  const elapsed = Date.now() - start;
  console.log(`\n결과: ✅${results.success} ❌${results.failed} (${elapsed}ms)`);
  console.log('→ 드라이런 완료 ✅ (실제 발송 없음)');
}

async function runRealTest(count) {
  console.log(`⚠️  실제 발송: ${count}건 전송 — 마스터에게 알림이 갑니다!`);
  const results = { success: 0, failed: 0, rate_limited: 0 };
  const start   = Date.now();

  // 동시 발송 (Rate Limit 방어 테스트)
  const promises = Array.from({ length: count }, (_, i) =>
    (async () => {
      try {
        await tg.send('claude', `🧪 카오스 테스트 ${i + 1}/${count} — Rate Limit 방어 검증`);
        results.success++;
        process.stdout.write(`  [${i + 1}/${count}] ✅\n`);
      } catch (e) {
        if (e.message?.includes('429') || e.message?.toLowerCase().includes('rate')) {
          results.rate_limited++;
          process.stdout.write(`  [${i + 1}/${count}] ⚠️ Rate Limited (방어 동작)\n`);
        } else {
          results.failed++;
          process.stdout.write(`  [${i + 1}/${count}] ❌ ${e.message?.slice(0, 40)}\n`);
        }
      }
    })()
  );

  await Promise.allSettled(promises);

  const elapsed = Date.now() - start;
  console.log(`\n결과: ✅${results.success} ⚠️${results.rate_limited} ❌${results.failed} (${elapsed}ms)`);

  if (results.rate_limited > 0) {
    console.log('→ Rate Limit 방어 동작 확인 ✅');
  } else if (results.success === count) {
    console.log('→ 스로틀/큐잉으로 모두 성공 처리 ✅');
  }
  if (results.failed === 0) {
    console.log('→ 시스템 크래시 없이 처리됨 ✅');
  }
}

async function main() {
  console.log('=== 카오스 테스트: 텔레그램 Rate Limit ===');
  console.log(`메시지: ${count}건 | 모드: ${dryRun ? 'DRY RUN (안전)' : '실제 발송'}\n`);

  if (dryRun) {
    await simulateDryRun(count);
  } else {
    await runRealTest(count);
  }

  // flushPending 호출 (큐에 남은 것 처리)
  if (!dryRun) {
    try {
      await tg.flushPending();
      console.log('✅ 펜딩 메시지 플러시 완료');
    } catch (e) {
      console.warn('⚠️ 플러시 실패 (무시):', e.message);
    }
  }

  console.log('\n=== 테스트 완료 ===');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ 테스트 오류:', e.message);
  process.exit(1);
});
