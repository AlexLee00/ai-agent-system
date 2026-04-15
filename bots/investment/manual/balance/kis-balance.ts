// @ts-nocheck
/**
 * manual/balance/kis-balance.js — KIS 한국투자증권 잔고 조회
 *
 * 사용: node manual/balance/kis-balance.js [--type=domestic|overseas|all]
 * 기본: all (국내+해외)
 * 출력: JSON { ok, domestic?, overseas?, paper }
 */

import { getDomesticBalance, getOverseasBalance } from '../../shared/kis-client.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

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

    result.aiSummary = await buildInvestmentCliInsight({
      bot: 'kis-balance',
      requestType: 'balance',
      title: 'KIS 잔고 조회 결과',
      data: {
        type,
        hasDomestic: Boolean(result.domestic),
        hasOverseas: Boolean(result.overseas),
        domesticKeys: result.domestic ? Object.keys(result.domestic).slice(0, 8) : [],
        overseasKeys: result.overseas ? Object.keys(result.overseas).slice(0, 8) : [],
      },
      fallback: type === 'all'
        ? '국내외 KIS 잔고가 함께 조회돼 현재 증권 계좌 상태를 한 번에 점검할 수 있습니다.'
        : type === 'domestic'
          ? '국내 KIS 잔고가 정상 조회돼 원화 계좌 상태 확인이 가능합니다.'
          : '해외 KIS 잔고가 정상 조회돼 달러 계좌 상태 확인이 가능합니다.',
    });
    output(result);
  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'kis-balance',
      requestType: 'balance',
      title: 'KIS 잔고 조회 결과',
      data: {
        type,
        error: e.message,
      },
      fallback: 'KIS 잔고 조회가 실패해 증권 계좌 상태를 수동으로 다시 확인하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, aiSummary });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
