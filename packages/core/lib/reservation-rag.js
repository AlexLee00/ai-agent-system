'use strict';

function formatReservationCaseHits(hits = []) {
  if (!hits || hits.length === 0) return null;
  return hits.map((hit) => ({
    content: (hit.content || '').slice(0, 150),
    date: hit.created_at ? new Date(hit.created_at).toLocaleDateString('ko-KR') : '',
  }));
}

async function searchReservationCases(rag, issueType, detail, {
  limit = 3,
  threshold = 0.6,
  sourceBot = null,
} = {}) {
  try {
    const query = `${issueType} ${detail}`.slice(0, 200);
    const hits = await rag.search('reservations', query, {
      limit,
      threshold,
      ...(sourceBot ? { sourceBot } : {}),
    });
    return formatReservationCaseHits(hits);
  } catch {
    return null;
  }
}

async function storeReservationResolution(rag, {
  issueType = '알람',
  detail = '',
  resolution = '처리 완료',
  sourceBot = 'ska-commander',
}) {
  return rag.store(
    'reservations',
    `[알람 처리] ${issueType} | ${detail} | 조치: ${resolution}`,
    { type: issueType, detail, resolution },
    sourceBot,
  );
}

async function storeReservationAuditSummary(rag, {
  date,
  total = 0,
  autoCount = 0,
  manualCount = 0,
  sourceBot = 'audit',
}) {
  const summary = `[일간 예약 감사 ${date}] 총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건 | ` +
    `이슈: ${manualCount > 0 ? `수동 ${manualCount}건 감지` : '없음'}`;
  return rag.store('reservations', summary, {
    date,
    type: 'daily_audit',
    total,
    auto_count: autoCount,
    manual_count: manualCount,
  }, sourceBot);
}

async function storeReservationEvent(rag, booking, {
  status = '신규',
  sourceBot = 'naver-monitor',
} = {}) {
  const name = booking?.raw?.name || '고객';
  const content = [
    `예약자: ${name}`,
    `날짜: ${booking?.date || ''}`,
    `시간: ${booking?.start || ''}~${booking?.end || ''}`,
    `공간: ${booking?.room || ''}`,
    `전화: ${booking?.phone || ''}`,
    `상태: ${status}`,
  ].join(' | ');

  return rag.store('reservations', content, {
    type: 'reservation',
    date: String(booking?.date || ''),
    status: String(status || ''),
    room: String(booking?.room || ''),
    phone: String(booking?.phone || ''),
    bookingId: String(booking?.bookingId || booking?._key || ''),
    savedAt: new Date().toISOString(),
  }, sourceBot);
}

module.exports = {
  formatReservationCaseHits,
  searchReservationCases,
  storeReservationResolution,
  storeReservationAuditSummary,
  storeReservationEvent,
};
