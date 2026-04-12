import { resolveStudyRoomAmount, buildRoomAmountsFromEntries, timeToMinutes } from './study-room-pricing';

type ReservationLike = Record<string, any>;

export type DailyClassification = {
  type: 'naver' | 'kiosk' | 'manual';
  naverBlocked: boolean | null;
};

type ClassifiedEntry = ReservationLike & {
  cls: DailyClassification;
};

export type DailySummaryBuildResult =
  | string
  | {
      msg: string;
      totalAmount: number;
      roomAmounts: Record<string, number>;
    };

export function getTodayKST(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function getHourKST(): number {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
}

export function getYesterdayKST(): string {
  const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateHeader(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00+09:00`);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = dayNames[date.getDay()];
  return `${mm}/${dd} (${dow})`;
}

export function formatAmount(amount: unknown): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '?원';
  return `${Number(amount).toLocaleString('ko-KR')}원`;
}

export function calcAmount(entry: ReservationLike): number {
  return resolveStudyRoomAmount(entry);
}

export function classifyEntry(
  entry: ReservationLike,
  naverKeys: Set<string>,
  kioskMap: Record<string, boolean>,
): DailyClassification {
  const naverKey = `${entry.phoneRaw}|${entry.date}|${entry.start}`;
  if (entry.phoneRaw && naverKeys.has(naverKey)) return { type: 'naver', naverBlocked: null };

  const kioskKey = `${entry.date}|${entry.start}|${entry.room || ''}`;
  if (kioskKey in kioskMap) return { type: 'kiosk', naverBlocked: kioskMap[kioskKey] };

  return { type: 'manual', naverBlocked: null };
}

export function classifyLabel(classification: DailyClassification): string {
  if (classification.type === 'naver') return '[네이버]';
  if (classification.type === 'kiosk') return classification.naverBlocked ? '[키오스크 ✅]' : '[키오스크 ⚠️]';
  return '[수동]';
}

export function buildDailySummaryMessage(
  today: string,
  entries: ReservationLike[],
  naverKeys: Set<string>,
  kioskMap: Record<string, boolean>,
  isMidnight: boolean,
  pickkoStats: Record<string, any> | null = null,
): DailySummaryBuildResult {
  const dateHeader = formatDateHeader(today);

  if (entries.length === 0) {
    const base = `📋 오늘 예약 · ${dateHeader}\n\n예약 없음`;
    if (isMidnight) {
      const generalRevenue = pickkoStats ? Number(pickkoStats.generalRevenue || 0) : 0;
      return {
        msg: `${base}\n\n💰 총 매출: ${formatAmount(generalRevenue)}\n\n❓ 오늘 매출을 확정하시겠습니까?`,
        totalAmount: generalRevenue,
        roomAmounts: {},
      };
    }
    return base;
  }

  const sorted = [...entries].sort((a, b) => {
    const diff = timeToMinutes(a.start) - timeToMinutes(b.start);
    return diff !== 0 ? diff : String(a.room || '').localeCompare(String(b.room || ''));
  });

  const classified: ClassifiedEntry[] = sorted.map((entry) => ({ ...entry, cls: classifyEntry(entry, naverKeys, kioskMap) }));
  const roomAmounts = buildRoomAmountsFromEntries(classified);

  let totalAmount = 0;
  for (const entry of classified) totalAmount += calcAmount(entry);
  const generalRevenue = isMidnight && pickkoStats ? Number(pickkoStats.generalRevenue || 0) : 0;
  const displayTotal = isMidnight ? totalAmount + generalRevenue : totalAmount;

  const roomCount: Record<string, number> = {};
  for (const entry of sorted) {
    const room = entry.room || '?';
    roomCount[room] = (roomCount[room] || 0) + 1;
  }
  const roomSummary = Object.entries(roomCount)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([room, count]) => `${room}×${count}`)
    .join(' / ');

  const sep = '━━━━━━━━━━━━━━━';
  let msg = `📋 오늘 예약 · ${dateHeader}\n\n`;
  msg += `총 ${sorted.length}건 | ${formatAmount(displayTotal)}\n`;
  msg += `${sep}\n`;

  for (const entry of classified) {
    msg += `${entry.start || '?'}~${entry.end || '?'}  ${entry.room || '?'}  ${entry.name || '(이름없음)'}  ${formatAmount(calcAmount(entry))}  ${classifyLabel(entry.cls)}\n`;
  }

  msg += `${sep}\n`;
  msg += roomSummary;

  const unblocked = classified.filter((entry) => entry.cls.type === 'kiosk' && !entry.cls.naverBlocked);
  const manual = classified.filter((entry) => entry.cls.type === 'manual');

  if (unblocked.length > 0) {
    msg += `\n\n⚠️ 네이버 차단 미완료 (${unblocked.length}건):`;
    for (const entry of unblocked) msg += `\n• ${entry.start}~${entry.end} ${entry.room} ${entry.name || '(이름없음)'}`;
  }
  if (manual.length > 0) {
    msg += `\n\n📞 수동 등록 — 네이버 확인 필요 (${manual.length}건):`;
    for (const entry of manual) msg += `\n• ${entry.start}~${entry.end} ${entry.room} ${entry.name || '(이름없음)'}`;
  }

  if (isMidnight) {
    const grandTotal = generalRevenue + totalAmount;
    msg += `\n\n💰 매출 현황:\n`;
    if (pickkoStats && generalRevenue > 0) msg += `  일반이용: ${formatAmount(generalRevenue)}\n`;
    for (const [room, amount] of Object.entries(roomAmounts).sort(([a], [b]) => a.localeCompare(b))) {
      msg += `  ${room}: ${formatAmount(amount)}\n`;
    }
    msg += `  합계: ${formatAmount(grandTotal)}\n`;
    msg += `\n❓ 오늘 매출을 확정하시겠습니까?`;
    return { msg, totalAmount: grandTotal, roomAmounts };
  }

  return { msg, totalAmount, roomAmounts };
}

function fmtPhone(raw: string): string {
  return raw.length === 11 ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}` : raw;
}

export function buildDailyAuditReport(today: string, pickkoEntries: ReservationLike[], autoMatched: ReservationLike[], manualEntries: ReservationLike[]): string {
  const total = pickkoEntries.length;
  const autoCount = autoMatched.length;
  const manualCount = manualEntries.length;

  if (total === 0) {
    return `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n당일 접수 기준 신규 예약이 없습니다.\n오늘 이용 예약이 없다는 뜻은 아닙니다.`;
  }

  if (manualCount === 0) {
    return `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n✅ 당일 접수 ${total}건 모두 auto\n네이버 예약 자동 등록 정상 처리됨`;
  }

  let report = `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n`;
  report += `총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건\n\n`;
  report += `⚠️ 수동(전화/직접) 등록 항목:\n`;
  report += '━━━━━━━━━━━━━━━\n';
  for (const entry of manualEntries) {
    report += `• ${entry.name || '(이름없음)'} ${entry.phoneRaw ? fmtPhone(entry.phoneRaw) : '(번호없음)'}\n`;
    report += `  ${entry.date} ${entry.start}~${entry.end} ${entry.room || ''}\n`;
  }
  return report;
}
