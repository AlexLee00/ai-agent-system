// @ts-nocheck
'use strict';

function cryptoFixture() {
  return {
    marketData: {
      btc_price: 106500,
      btc_symbol: 'BTC/USDT',
      btc_change_24h: 1.8,
      eth_price: 3820,
      eth_symbol: 'ETH/USDT',
      eth_change_24h: 1.2,
      fear_greed_index: 68,
      fear_greed_label: 'Greed',
      top_coins: [
        { symbol: 'BTC/USDT', price: 106500, change_24h: 1.8, market_cap: 2100 },
        { symbol: 'ETH/USDT', price: 3820, change_24h: 1.2, market_cap: 460 },
        { symbol: 'BNB/USDT', price: 690, change_24h: 0.6, market_cap: 103 },
        { symbol: 'SOL/USDT', price: 178, change_24h: 3.4, market_cap: 88 },
        { symbol: 'XRP/USDT', price: 2.31, change_24h: -0.8, market_cap: 132 },
      ],
      altcoins: [
        { symbol: 'SOL/USDT', price: 178, change_24h: 3.4, trigger: '거래량 회복' },
        { symbol: 'BNB/USDT', price: 690, change_24h: 0.6, trigger: '상위 거래량 유지' },
        { symbol: 'XRP/USDT', price: 2.31, change_24h: -0.8, trigger: '변동성 축소' },
      ],
      schedule: [
        { time: '21:30', event: '미국 고용 지표' },
        { time: '23:00', event: '주요 연준 인사 발언' },
      ],
    },
    evidenceItems: [
      { sourceName: 'luna-community', symbol: 'BTC/USDT', evidenceSummary: 'BTC 현물 ETF 순유입과 상위 거래량 종목 중심의 회전매가 관측됨', signalDirection: 'positive', rawRef: { mentions: 118 } },
      { sourceName: 'luna-community', symbol: 'BTC/USDT', evidenceSummary: 'BTC 옵션 만기 전 변동성 확대 가능성이 커뮤니티에서 반복 언급됨', signalDirection: 'neutral', rawRef: { mentions: 73 } },
      { sourceName: 'luna-community', symbol: 'BTC/USDT', evidenceSummary: 'BTC 장기 보유자 매도 압력은 제한적이라는 온체인 해석이 공유됨', signalDirection: 'positive', rawRef: { mentions: 42 } },
    ],
    technicalData: { rsi: 57, macd: '+92.68 (상승 모멘텀)', support: 104200, resistance: 108900, volume_24h: '$72B' },
    ohlcvData: {
      prices: Array.from({ length: 24 }, (_, i) => 104000 + i * 105 + (i % 5) * 180),
      times: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
    },
  };
}

function kisFixture() {
  return {
    marketData: {
      kospi_index: 2920,
      kospi_change: 0.7,
      kosdaq_index: 884,
      kosdaq_change: 0.4,
      usd_krw: 1362,
      foreign_net_buy: 185000000000,
      institution_net_buy: -72000000000,
      sectors: [
        { name: '반도체', change: 1.4, change_1d: 1.4 },
        { name: '2차전지', change: -0.6, change_1d: -0.6 },
        { name: '바이오', change: 0.9, change_1d: 0.9 },
        { name: '금융', change: 0.3, change_1d: 0.3 },
      ],
      indexSeries: {
        times: ['D-5', 'D-4', 'D-3', 'D-2', 'D-1', 'D'],
        kospi: [2870, 2888, 2894, 2910, 2904, 2920],
        kosdaq: [862, 870, 875, 879, 881, 884],
      },
      events: [
        { time: '09:30', event: '반도체 수출 지표 확인' },
        { time: '10:00', event: '기관 수급 변화 점검' },
      ],
    },
    evidenceItems: [
      { sourceName: 'luna-domestic', evidenceSummary: '반도체 대형주 중심으로 외국인 순매수 재개 조짐', signalDirection: 'positive' },
      { sourceName: 'luna-domestic', evidenceSummary: '2차전지는 가격 부담과 환율 영향으로 선별 접근 필요', signalDirection: 'neutral' },
    ],
  };
}

function overseasFixture() {
  return {
    marketData: {
      sp500_index: 6250,
      sp500_change: 0.5,
      nasdaq_index: 20580,
      nasdaq_change: 0.8,
      dxy: 101.2,
      vix: 14.9,
      mag7: [
        { symbol: 'NVDA', price: 142, change_1d: 2.1 },
        { symbol: 'MSFT', price: 513, change_1d: 0.8 },
        { symbol: 'AAPL', price: 214, change_1d: -0.3 },
        { symbol: 'AMZN', price: 221, change_1d: 0.5 },
        { symbol: 'META', price: 650, change_1d: 1.1 },
        { symbol: 'GOOGL', price: 178, change_1d: 0.6 },
        { symbol: 'TSLA', price: 185, change_1d: -1.2 },
      ],
      indexSeries: {
        times: ['D-5', 'D-4', 'D-3', 'D-2', 'D-1', 'D'],
        sp500: [6170, 6185, 6202, 6211, 6220, 6250],
        nasdaq: [20220, 20310, 20390, 20440, 20490, 20580],
      },
      top_etfs: [
        { symbol: 'QQQ', market_cap: 280 },
        { symbol: 'XLK', market_cap: 85 },
        { symbol: 'XLE', market_cap: 42 },
      ],
      earnings: [
        { date: '오늘', symbol: 'NVDA', eps_est: '1.10' },
        { date: '내일', symbol: 'ADBE', eps_est: '4.75' },
      ],
    },
    evidenceItems: [
      { sourceName: 'luna-overseas', evidenceSummary: 'AI 인프라 관련 대형주가 지수 상승을 견인', signalDirection: 'positive' },
      { sourceName: 'luna-overseas', evidenceSummary: 'VIX 안정 구간이나 금리 이벤트 전 변동성 확대 가능성 존재', signalDirection: 'neutral' },
    ],
  };
}

function getFixturePayload(category) {
  if (category === 'crypto') return cryptoFixture();
  if (category === 'kis') return kisFixture();
  if (category === 'overseas') return overseasFixture();
  return {};
}

module.exports = { getFixturePayload, cryptoFixture, kisFixture, overseasFixture };
