type FinalizationDeps = {
  log: (message: string) => void;
  buildStageError: (code: string, message: string) => Error;
};

const { extractPickkoFinalPaymentAmount } = require('./report-followup-helpers');

type VerifyDraftArgs = {
  date: string;
  room: string;
  phoneNoHyphen: string;
  start?: string;
  end?: string;
};

type FinalStatusExpectation = {
  date: string;
  room: string;
  start: string;
  end: string;
  requireZeroAmount?: boolean;
};

export function matchesPickkoReservationWindow(
  useTime: unknown,
  expected: { date?: unknown; start?: unknown; end?: unknown },
): boolean {
  const dateMatch = String(useTime || '').match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/u);
  const clocks = [...String(useTime || '').matchAll(/(\d{1,2})시\s*(\d{1,2})분/gu)]
    .map((match) => `${String(Number(match[1])).padStart(2, '0')}:${String(Number(match[2])).padStart(2, '0')}`);
  const actualDate = dateMatch
    ? `${dateMatch[1]}-${String(Number(dateMatch[2])).padStart(2, '0')}-${String(Number(dateMatch[3])).padStart(2, '0')}`
    : '';
  return actualDate === String(expected.date || '')
    && clocks[0] === String(expected.start || '')
    && clocks[1] === String(expected.end || '');
}

export function createPickkoFinalizationService({
  log,
  buildStageError,
}: FinalizationDeps) {
  async function verifyReservationDraft(page: any, { date, room, phoneNoHyphen, start, end }: VerifyDraftArgs) {
    log('\n[7-5단계] 최종 검증 (결제 직전)');

    const finalVerification = await page.evaluate(() => {
      const verification: {
        mbInfo: string | null;
        roomName: string | null;
        useTime: string | null;
        priceField: string | null;
        errors: string[];
        warnings: string[];
      } = {
        mbInfo: null,
        roomName: null,
        useTime: null,
        priceField: null,
        errors: [],
        warnings: [],
      };

      const rows = document.querySelectorAll('tbody tr');
      for (const row of Array.from(rows)) {
        const th = row.querySelector('th');
        const tds = row.querySelectorAll('td');
        if (!th || !tds.length) continue;

        const thText = (th.textContent || '').trim();

        if (thText.includes('회원 정보')) {
          const mbSpan = row.querySelector('span#mb_info');
          if (mbSpan) verification.mbInfo = (mbSpan.textContent || '').trim();
        }

        if (thText.includes('스터디룸') && tds[0]) {
          verification.roomName = (tds[0].textContent || '').trim();
        }

        if (thText.includes('이용시간')) {
          for (const td of Array.from(tds)) {
            const tdText = (td.textContent || '').trim();
            if (tdText.includes('년') || tdText.includes('월') || tdText.includes('일')) {
              verification.useTime = tdText;
              break;
            }
          }
        }

        if (thText.includes('결제하기')) {
          const orderLink = row.querySelector('a#study_order');
          if (orderLink) {
            const price = orderLink.getAttribute('price');
            verification.priceField = price ? `${price}원` : null;
          }
        }
      }

      if (!verification.mbInfo) verification.errors.push('회원 정보를 찾을 수 없습니다');
      if (!verification.roomName) verification.errors.push('스터디룸 정보를 찾을 수 없습니다');
      if (!verification.useTime) verification.errors.push('이용시간 정보를 찾을 수 없습니다');
      if (!verification.priceField) verification.errors.push('결제금액 정보를 찾을 수 없습니다');

      return verification;
    });

    log('✅ [7-5] 예약 정보 추출 완료:');
    log(`   회원: ${finalVerification.mbInfo || '(미확인)'}`);
    log(`   룸: ${finalVerification.roomName || '(미확인)'}`);
    log(`   시간: ${finalVerification.useTime || '(미확인)'}`);
    log(`   가격: ${finalVerification.priceField || '(미확인)'}`);

    if (finalVerification.errors.length > 0) {
      log(`❌ 검증 실패: ${finalVerification.errors.join(', ')}`);
      throw buildStageError(
        'SAVE_FINAL_VERIFICATION_FAILED',
        `[7-5검증] 예약 정보 추출 실패: ${finalVerification.errors.join(', ')}`,
      );
    }

    log('\n🔍 [7-6단계] 파싱 데이터와 비교:');
    const comparisonErrors: string[] = [];

    const digitsOnly = phoneNoHyphen.replace(/\D/g, '');
    const parenMatch = finalVerification.mbInfo!.match(/\(([^)]+)\)/);
    const extractedPhoneDigits = parenMatch
      ? parenMatch[1].replace(/\D/g, '')
      : finalVerification.mbInfo!.replace(/\D/g, '');
    if (extractedPhoneDigits !== digitsOnly) {
      comparisonErrors.push(`번호 불일치: 픽코=${finalVerification.mbInfo}, 네이버=${phoneNoHyphen}`);
    }

    if (!finalVerification.roomName!.includes(room)) {
      comparisonErrors.push(`룸 불일치: 픽코=${finalVerification.roomName}, 네이버=${room}`);
    }

    const [year, month, day] = date.split('-');
    const expectedDate = `${year}년 ${month}월 ${day}일`;
    if (!finalVerification.useTime!.includes(expectedDate)) {
      comparisonErrors.push(`날짜 불일치: 픽코=${finalVerification.useTime!.slice(0, 20)}, 네이버=${expectedDate}`);
    }
    if (start && end && !matchesPickkoReservationWindow(finalVerification.useTime, { date, start, end })) {
      comparisonErrors.push(`시간 불일치: 픽코=${finalVerification.useTime}, 기대=${start}~${end}`);
    }

    if (comparisonErrors.length > 0) {
      log(`❌ 데이터 불일치: ${comparisonErrors.join(', ')}`);
      throw buildStageError(
        'SAVE_COMPARISON_FAILED',
        `[7-6검증] 파싱 데이터 불일치: ${comparisonErrors.join(', ')}`,
      );
    }

    log('✅ [7-6] 모든 데이터 일치 확인됨! 결제 진행 가능');
    log('   회원번호: ✅');
    log('   룸: ✅');
    log('   날짜: ✅');
    if (start && end) log('   시간: ✅');

    return finalVerification;
  }

  async function readFinalStatus(page: any, expected: FinalStatusExpectation | null = null) {
    const rawFinalStatus = await page.evaluate((expectedReservation: FinalStatusExpectation | null) => {
      const hasOrderResultUrl = /\/order\/view\/\d+/.test(window.location.href);
      const activeOrderView = hasOrderResultUrl ? document.querySelector('#order_view') : null;
      const statusRoot = (activeOrderView || document.querySelector('body')) as HTMLElement | null;
      const bodyText = statusRoot?.innerText || '';
      const normalizedLines = bodyText
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim());
      const paymentStatuses = [...new Set(normalizedLines
        .map((line) => {
          if (line === '결제대기' || line === '결제완료') return line;
          return line.match(/^(?:결제\s*상태|상태)\s*[:：-]?\s*(결제대기|결제완료)$/)?.[1] || '';
        })
        .filter(Boolean))];
      const compactBody = bodyText.replace(/\s+/g, '').toUpperCase();
      const [year = '', month = '', day = ''] = String(expectedReservation?.date || '').split('-');
      const dateToken = year && month && day ? `${Number(month)}월${Number(day)}일` : '';
      const clockToken = (value: string | undefined) => {
        const [hour = '', minute = ''] = String(value || '').split(':');
        return hour && minute ? `${Number(hour)}시${String(Number(minute)).padStart(2, '0')}분` : '';
      };
      const expectedTokens = expectedReservation ? [
        `스터디룸${String(expectedReservation.room || '').replace(/^스터디룸/u, '').replace(/룸$/u, '').toUpperCase()}`,
        dateToken,
        clockToken(expectedReservation.start),
        clockToken(expectedReservation.end),
      ] : [];
      return {
        pageTitle: document.title || '',
        hasErrorMsg: bodyText.includes('에러'),
        hasSuccessMsg: bodyText.includes('완료'),
        isPaymentPending: paymentStatuses.includes('결제대기'),
        isPaymentCompleted: paymentStatuses.includes('결제완료'),
        paymentStatusText: paymentStatuses.join(' / '),
        hasOrderResultRoot: activeOrderView !== null,
        identityMatched: expectedTokens.every((token) => token && compactBody.includes(token)),
        bodyText,
        url: window.location.href,
        timestamp: new Date().toLocaleString('ko-KR'),
      };
    }, expected);
    const { bodyText, ...evaluatedStatus } = rawFinalStatus as Record<string, any>;
    const paymentAmountWon = extractPickkoFinalPaymentAmount(bodyText);
    const finalStatus = {
      ...evaluatedStatus,
      paymentAmountWon,
      zeroAmountMatched: paymentAmountWon === 0,
    };

    const hasOrderUrl = /\/order\/view\/\d+/.test(finalStatus.url);
    const strictExpectationMatched = !expected || (
      finalStatus.hasOrderResultRoot === true
      && finalStatus.identityMatched === true
      && (expected.requireZeroAmount !== true || finalStatus.zeroAmountMatched === true)
    );
    const isSuccess = !finalStatus.hasErrorMsg
      && hasOrderUrl
      && finalStatus.isPaymentCompleted
      && !finalStatus.isPaymentPending
      && strictExpectationMatched;

    log(`🔍 최종 상태: ${JSON.stringify(finalStatus)}`);

    return {
      ...finalStatus,
      hasOrderUrl,
      isSuccess,
    };
  }

  return {
    verifyReservationDraft,
    readFinalStatus,
  };
}
