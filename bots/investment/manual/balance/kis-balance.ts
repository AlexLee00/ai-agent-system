// @ts-nocheck
/**
 * manual/balance/kis-balance.js — KIS 한국투자증권 잔고 조회
 *
 * 사용: node manual/balance/kis-balance.js [--type=domestic|overseas|all]
 * 기본: all (국내+해외)
 * 출력: JSON { ok, domestic?, overseas?, paper }
 */

import { getDomesticBalance, getOverseasBalance } from '../../shared/kis-client.ts';

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? '']; })
  );

  const type = args.type || 'all';

  try {
    const result = { ok: true };

    if (type === 'domestic' || type === 'all') {
      result.domestic = await getDomesticBalance();
    }

    if (type === 'overseas' || type === 'all') {
      result.overseas = await getOverseasBalance();
    }

    output(result);
  } catch (e) {
    output({ ok: false, error: e.message });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
