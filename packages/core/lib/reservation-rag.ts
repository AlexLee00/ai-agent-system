import { publishToRag } from './reporting-hub';

type RagHit = {
  content?: string | null;
  created_at?: string | null;
};

type RagLike = {
  store: (collection: string, content: string, metadata?: Record<string, unknown>, sourceBot?: string) => Promise<unknown>;
  search: (
    collection: string,
    query: string,
    options?: { limit?: number; threshold?: number; sourceBot?: string | null },
  ) => Promise<RagHit[]>;
};

type Booking = {
  raw?: { name?: string };
  date?: string;
  start?: string;
  end?: string;
  room?: string;
  phone?: string;
  bookingId?: string;
  _key?: string;
};

function createRagStoreAdapter(rag: RagLike) {
  return {
    async store(collection: string, content: string, metadata: Record<string, unknown> = {}, sourceBot = 'unknown') {
      return rag.store(collection, content, metadata, sourceBot);
    },
  };
}

export function formatReservationCaseHits(hits: RagHit[] = []): Array<{ content: string; date: string }> | null {
  if (!hits || hits.length === 0) return null;
  return hits.map((hit) => ({
    content: String(hit.content || '').slice(0, 150),
    date: hit.created_at ? new Date(hit.created_at).toLocaleDateString('ko-KR') : '',
  }));
}

export async function searchReservationCases(
  rag: RagLike,
  issueType: string,
  detail: string,
  {
    limit = 3,
    threshold = 0.6,
    sourceBot = null,
  }: { limit?: number; threshold?: number; sourceBot?: string | null } = {},
): Promise<Array<{ content: string; date: string }> | null> {
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

export async function storeReservationResolution(
  rag: RagLike,
  {
    issueType = '알람',
    detail = '',
    resolution = '처리 완료',
    sourceBot = 'ska-commander',
  }: {
    issueType?: string;
    detail?: string;
    resolution?: string;
    sourceBot?: string;
  } = {},
): Promise<unknown> {
  const result = (await publishToRag({
    ragStore: createRagStoreAdapter(rag),
    collection: 'reservations',
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'reservation',
      event_type: 'resolution',
      alert_level: 1,
      message: `[알람 처리] ${issueType} | ${detail} | 조치: ${resolution}`,
      payload: {
        title: issueType,
        summary: detail,
        action: resolution,
      },
    },
    metadata: { type: issueType, detail, resolution },
  })) as { id?: unknown };
  return result.id;
}

export async function storeReservationAuditSummary(
  rag: RagLike,
  {
    date,
    total = 0,
    autoCount = 0,
    manualCount = 0,
    sourceBot = 'audit',
  }: {
    date: string;
    total?: number;
    autoCount?: number;
    manualCount?: number;
    sourceBot?: string;
  },
): Promise<unknown> {
  const summary =
    `[일간 예약 감사 ${date}] 총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건 | ` +
    `이슈: ${manualCount > 0 ? `수동 ${manualCount}건 감지` : '없음'}`;
  const result = (await publishToRag({
    ragStore: createRagStoreAdapter(rag),
    collection: 'reservations',
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'reservation',
      event_type: 'report',
      alert_level: 1,
      message: summary,
      payload: {
        title: `일간 예약 감사 ${date}`,
        summary: `총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건`,
        details: [manualCount > 0 ? `수동 ${manualCount}건 감지` : '이슈 없음'],
      },
    },
    metadata: {
      date,
      type: 'daily_audit',
      total,
      auto_count: autoCount,
      manual_count: manualCount,
    },
  })) as { id?: unknown };
  return result.id;
}

export async function storeReservationEvent(
  rag: RagLike,
  booking: Booking,
  {
    status = '신규',
    sourceBot = 'naver-monitor',
  }: {
    status?: string;
    sourceBot?: string;
  } = {},
): Promise<unknown> {
  const name = booking?.raw?.name || '고객';
  const content = [
    `예약자: ${name}`,
    `날짜: ${booking?.date || ''}`,
    `시간: ${booking?.start || ''}~${booking?.end || ''}`,
    `공간: ${booking?.room || ''}`,
    `전화: ${booking?.phone || ''}`,
    `상태: ${status}`,
  ].join(' | ');

  const result = (await publishToRag({
    ragStore: createRagStoreAdapter(rag),
    collection: 'reservations',
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'reservation',
      event_type: 'reservation',
      alert_level: 1,
      message: content,
      payload: {
        title: `예약 상태: ${status}`,
        summary: `${name} / ${booking?.date || ''} / ${booking?.room || ''}`,
        details: [`시간: ${booking?.start || ''}~${booking?.end || ''}`, `전화: ${booking?.phone || ''}`],
      },
    },
    metadata: {
      type: 'reservation',
      date: String(booking?.date || ''),
      status: String(status || ''),
      room: String(booking?.room || ''),
      phone: String(booking?.phone || ''),
      bookingId: String(booking?.bookingId || booking?._key || ''),
      savedAt: new Date().toISOString(),
    },
  })) as { id?: unknown };
  return result.id;
}
