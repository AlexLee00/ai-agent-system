// @ts-nocheck
function toKst(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function evaluateKisMarketHours({ market = 'domestic', now = new Date() } = {}) {
  const kst = toKst(now);
  const day = kst.getDay();
  const mins = minutesOfDay(kst);
  const weekday = day >= 1 && day <= 5;
  const domestic = String(market).toLowerCase().includes('domestic') || String(market).toLowerCase().includes('kis');
  const open = domestic ? 9 * 60 : 23 * 60 + 30;
  const close = domestic ? 15 * 60 + 30 : 6 * 60;
  const inWindow = domestic
    ? mins >= open && mins <= close
    : mins >= open || mins <= close;
  const isOpen = weekday && inWindow;
  return {
    market,
    isOpen,
    state: isOpen ? 'open' : 'closed',
    reasonCode: isOpen ? 'kis_market_open' : 'kis_market_closed',
    nextAction: isOpen ? 'allow' : 'defer_until_open',
    kst: kst.toISOString(),
  };
}

export default { evaluateKisMarketHours };
