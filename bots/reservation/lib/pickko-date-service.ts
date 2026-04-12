type PickkoDateServiceDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
  sendErrorNotification: (message: string, context?: Record<string, unknown>) => Promise<unknown>;
  buildStageError: (code: string, message: string) => Error;
};

export function createPickkoDateService({
  delay,
  log,
  sendErrorNotification,
  buildStageError,
}: PickkoDateServiceDeps) {
  function normalizeDate(dateStr: string) {
    if (!dateStr) return '';
    const match = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      const [, y, m, d] = match;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return dateStr;
  }

  async function setAndVerifyDate(
    page: any,
    {
      date,
      retryCount = 0,
    }: {
      date: string;
      retryCount?: number;
    },
  ): Promise<void> {
    if (retryCount >= 5) {
      const errorMsg = '❌ 날짜 검증 실패: 5회 시도 후에도 날짜 불일치';
      log(errorMsg);
      await sendErrorNotification(errorMsg, {
        step: '5단계',
        targetDate: date,
        retries: retryCount,
      });
      throw buildStageError('DATE_SELECT_FAILED', errorMsg);
    }

    const prevScheduleDate = await page.evaluate(() => {
      const li = document.querySelector('li#prev_schedule');
      let text = li ? (li.textContent || '').trim() : '';
      text = text.replace(/\s+/g, '').split('T')[0];
      return text;
    });

    let inputDate = await page.evaluate(() => {
      const inp = document.querySelector('input#start_date') as HTMLInputElement | null;
      let val = inp ? inp.value : '';
      val = val.replace(/\s+/g, '').split('T')[0];
      return val;
    });

    const prevScheduleDateNorm = normalizeDate(prevScheduleDate);
    const inputDateNorm = normalizeDate(inputDate);
    const targetDateNorm = normalizeDate(date);

    log(`📅 [${retryCount + 1}/5] 예약일자: ${prevScheduleDateNorm}`);
    log(`📅 [${retryCount + 1}/5] 입력필드: ${inputDateNorm}`);
    log(`📅 [${retryCount + 1}/5] 목표 날짜: ${targetDateNorm}`);

    if (inputDateNorm === prevScheduleDateNorm) {
      log('✅ 입력필드와 예약일자 일치. 날짜 설정 스킵!');
      return;
    }

    log('⚠️ 날짜가 다릅니다. 변환 진행...');

    log(`📅 [1단계] 날짜 값 직접 세팅: ${date}`);
    const setDateOk = await page.evaluate((dateStr: string) => {
      const inp = document.querySelector('input#start_date') as HTMLInputElement | null;
      if (!inp) return { ok: false, reason: 'no #start_date' };

      inp.focus();
      inp.value = dateStr;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));

      try {
        const w = window as any;
        if (w.jQuery && w.jQuery.fn && w.jQuery.fn.datepicker) {
          w.jQuery(inp).datepicker('setDate', dateStr);
          w.jQuery(inp).trigger('change');
        }
      } catch {}

      return { ok: true, value: inp.value };
    }, date);
    log(`📅 [1단계] 결과: ${JSON.stringify(setDateOk)}`);

    log('📅 [2단계] 달력 팝업 열기');
    await page.evaluate(() => {
      const inp = document.querySelector('input#start_date') as HTMLInputElement | null;
      if (!inp) return;
      const w = window as any;
      if (w.jQuery && w.jQuery.fn && w.jQuery.fn.datepicker) {
        w.jQuery(inp).datepicker('show');
      } else {
        inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    await delay(800);

    const [ty, tm, td] = date.split('-').map((n) => parseInt(n, 10));

    log(`📅 [3단계] 달력에서 ${ty}년 ${tm}월 ${td}일 클릭`);
    const clicked = await page.evaluate((year: number, month1: number, day: number) => {
      const m0 = month1 - 1;
      const dayStr = String(day);

      const cells = document.querySelectorAll(`td[data-handler="selectDay"][data-year="${year}"][data-month="${m0}"] a`);
      for (const a of cells) {
        if ((a.textContent || '').trim() === dayStr) {
          (a as HTMLElement).click();
          return true;
        }
      }

      const allLinks = document.querySelectorAll('.datepicker a, .ui-datepicker a');
      for (const a of allLinks) {
        const el = a as HTMLElement;
        if (
          (el.textContent || '').trim() === dayStr &&
          !el.classList.contains('disabled') &&
          !el.classList.contains('ui-state-disabled')
        ) {
          el.click();
          return true;
        }
      }

      return false;
    }, ty, tm, td);

    log(`📅 [3단계] 달력 클릭 결과: ${clicked ? '✅ 성공' : '❌ 실패'}`);
    await delay(1000);

    inputDate = await page.evaluate(() => (document.querySelector('input#start_date') as HTMLInputElement | null)?.value || '');
    if (inputDate !== date) {
      log(`⚠️ 최종 검증 실패: start_date=${inputDate} (expected ${date})`);
      await setAndVerifyDate(page, { date, retryCount: retryCount + 1 });
      return;
    }

    log(`✅ 최종 검증 성공: ${inputDate}`);
  }

  return {
    normalizeDate,
    setAndVerifyDate,
  };
}
