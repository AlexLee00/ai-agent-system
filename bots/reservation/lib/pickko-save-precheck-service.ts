type SavePrecheckDeps = {
  log: (message: string) => void;
  buildStageError: (code: string, message: string) => Error;
};

const { pickkoEndTime } = require('./formatting');

export function createPickkoSavePrecheckService({
  log,
  buildStageError,
}: SavePrecheckDeps) {
  function shiftMinutes(hhmm: string, deltaMin: number) {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
    const total = h * 60 + m + deltaMin;
    const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hh = String(Math.floor(normalized / 60)).padStart(2, '0');
    const mm = String(normalized % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function buildAcceptedEndTimes(expectedEndTime: string) {
    const trimmed = String(expectedEndTime || '').trim();
    const values = new Set<string>();
    if (!trimmed) return values;
    values.add(trimmed);

    const canonicalPickkoEnd = String(pickkoEndTime(trimmed) || '').trim();
    if (canonicalPickkoEnd) values.add(canonicalPickkoEnd);

    const minusFive = shiftMinutes(trimmed, -5);
    if (minusFive) values.add(minusFive);

    const minusTen = shiftMinutes(trimmed, -10);
    if (minusTen) values.add(minusTen);

    return values;
  }

  async function alignExpectedTimes(
    page: any,
    expected: {
      startDate: string;
      startTime: string;
      endDate?: string | null;
      endTime: string;
    },
  ) {
    const expectedStartDate = String(expected?.startDate || '').trim();
    const expectedStartTime = String(expected?.startTime || '').trim();
    const expectedEndDate = String(expected?.endDate || expectedStartDate || '').trim();
    const expectedEndTime = String(expected?.endTime || '').trim();

    const setField = async (selector: string, value: string) => {
      if (!value) return { changed: false, value: '' };
      const handle = await page.$(selector).catch(() => null);
      if (!handle) {
        return { changed: false, value: '' };
      }

      const prevHandle = await handle.getProperty('value').catch(() => null);
      const prev = String((await prevHandle?.jsonValue().catch(() => '')) || '').trim();
      await page.click(selector, { clickCount: 3 }).catch(async () => {
        await handle.click({ force: true }).catch(() => {});
      });
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.type(selector, value, { delay: 20 }).catch(() => {});
      const nextHandle = await handle.getProperty('value').catch(() => null);
      const next = String((await nextHandle?.jsonValue().catch(() => '')) || '').trim();
      return { changed: prev !== next, value: next };
    };

    const startDateResult = await setField('#start_date', expectedStartDate);
    const startTimeResult = await setField('#start_time', expectedStartTime);
    const endDateResult = await setField('#end_date', expectedEndDate);
    const endTimeResult = await setField('#end_time', expectedEndTime);

    const result = {
      startDateChanged: startDateResult.changed,
      startTimeChanged: startTimeResult.changed,
      endDateChanged: endDateResult.changed,
      endTimeChanged: endTimeResult.changed,
      startDate: startDateResult.value,
      startTime: startTimeResult.value,
      endDate: endDateResult.value,
      endTime: endTimeResult.value,
    };

    log(`🛠️ 저장 전 폼 시간 보정: ${JSON.stringify(result)}`);
    return result;
  }

  async function runSavePrecheck(
    page: any,
    expected: {
      startDate: string;
      startTime: string;
      endDate?: string | null;
      endTime: string;
    },
  ) {
    const sanity = await page.evaluate(`
      (() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();

        const startDate = clean(document.querySelector('#start_date')?.value);
        const startTime = clean(document.querySelector('#start_time')?.value);
        const endDate = clean(document.querySelector('#end_date')?.value);
        const endTime = clean(document.querySelector('#end_time')?.value);

        let priceText = null;
        let useTimeText = null;

        const rows = document.querySelectorAll('tr');
        for (const row of Array.from(rows)) {
          const th = row.querySelector('th');
          const td = row.querySelector('td');
          if (!th || !td) continue;

          const thText = clean(th.textContent);
          const tdText = clean(td.textContent);

          if (thText.includes('이용시간')) useTimeText = tdText;
          if (thText.includes('이용금액')) priceText = tdText;
        }

        if (!priceText) {
          const studyPrice = document.querySelector('#study_price');
          const fallback = clean(studyPrice?.innerText || studyPrice?.textContent);
          if (fallback) priceText = fallback;
        }

        const parseMoney = (s) => {
          if (!s) return null;
          const n = parseFloat(String(s).replace(/[^0-9.\\-]/g, ''));
          return Number.isFinite(n) ? n : null;
        };

        const priceNum = parseMoney(priceText);
        const badAmount = (typeof priceText === 'string' && priceText.includes('-')) || (priceNum !== null && priceNum < 0);
        const missingTime = !startTime || !endTime;

        const toTs = (d, t) => {
          if (!d || !t) return null;
          const ms = Date.parse(d + 'T' + t + ':00');
          return Number.isFinite(ms) ? ms : null;
        };

        const ts1 = toTs(startDate, startTime);
        const ts2 = toTs(endDate || startDate, endTime);

        let durationMin = null;
        if (ts1 !== null && ts2 !== null) {
          durationMin = Math.round((ts2 - ts1) / 60000);
        }

        const badTime = missingTime || (durationMin !== null && durationMin <= 0);

        return {
          startDate,
          startTime,
          endDate,
          endTime,
          durationMin,
          priceText,
          priceNum,
          useTimeText,
          badTime,
          badAmount,
          extracted: { hasPrice: !!priceText, hasUseTime: !!useTimeText },
        };
      })()
    `);

    log(`🧪 저장 전 확인: ${JSON.stringify(sanity)}`);

    const expectedStartDate = String(expected?.startDate || '').trim();
    const expectedStartTime = String(expected?.startTime || '').trim();
    const expectedEndDate = String(expected?.endDate || expectedStartDate || '').trim();
    const expectedEndTime = String(expected?.endTime || '').trim();

    const actualStartDate = String(sanity.startDate || '').trim();
    const actualStartTime = String(sanity.startTime || '').trim();
    const actualEndDate = String(sanity.endDate || actualStartDate || '').trim();
    const actualEndTime = String(sanity.endTime || '').trim();
    const acceptedEndTimes = buildAcceptedEndTimes(expectedEndTime);

    const mismatches: string[] = [];
    if (expectedStartDate && actualStartDate !== expectedStartDate) mismatches.push(`start_date=${actualStartDate} (expected ${expectedStartDate})`);
    if (expectedStartTime && actualStartTime !== expectedStartTime) mismatches.push(`start_time=${actualStartTime} (expected ${expectedStartTime})`);
    if (expectedEndDate && actualEndDate !== expectedEndDate) mismatches.push(`end_date=${actualEndDate} (expected ${expectedEndDate})`);
    if (expectedEndTime && !acceptedEndTimes.has(actualEndTime)) {
      mismatches.push(`end_time=${actualEndTime} (expected one of ${Array.from(acceptedEndTimes).join('/')})`);
    }

    if (
      expectedEndTime &&
      actualEndTime &&
      actualEndTime !== expectedEndTime &&
      acceptedEndTimes.has(actualEndTime)
    ) {
      log(`ℹ️ 저장 전 확인: 픽코 종료시간 보정 허용 (${actualEndTime}; 요청 ${expectedEndTime}, 허용=${Array.from(acceptedEndTimes).join('/')})`);
    }

    if (mismatches.length > 0) {
      throw buildStageError(
        'SAVE_TIME_MISMATCH',
        `저장 중단: 폼 시간이 요청값과 다름 (${mismatches.join(', ')})`,
      );
    }

    if (sanity.badTime) {
      throw buildStageError(
        'SAVE_TIME_VALIDATION_FAILED',
        `저장 중단: 시간 비정상 (start=${sanity.startDate} ${sanity.startTime}, end=${sanity.endDate || sanity.startDate} ${sanity.endTime}, durationMin=${sanity.durationMin})`,
      );
    }

    if (sanity.badAmount) {
      throw buildStageError(
        'SAVE_AMOUNT_VALIDATION_FAILED',
        `저장 중단: 금액 비정상 (가격=${sanity.priceText}, 파싱결과=${sanity.priceNum})`,
      );
    }

    if (!sanity.extracted?.hasPrice) {
      log('⚠️ 저장 전 확인: 이용금액을 찾지 못했습니다. (안전장치: 음수/시간 확인만 통과하면 계속)');
    }
    if (!sanity.extracted?.hasUseTime) {
      log('⚠️ 저장 전 확인: 이용시간을 찾지 못했습니다. (안전장치: 음수/시간 확인만 통과하면 계속)');
    }

    return sanity;
  }

  async function submitDraft(page: any) {
    log('💾 "작성하기" 버튼 클릭...');

    const submitClicked = await page.evaluate(`
      (() => {
        const btn = document.querySelector('input[type="submit"][value="작성하기"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `).catch(() => false);

    if (!submitClicked) {
      log('⚠️ 작성하기 버튼 미발견 → form.submit() 폴백');
      await page.evaluate(`
        (() => {
          const form = document.querySelector('form');
          if (form) HTMLFormElement.prototype.submit.call(form);
        })()
      `).catch(() => {});
    }

    log('✅ 작성하기 클릭 완료');
    return { submitClicked };
  }

  return {
    alignExpectedTimes,
    runSavePrecheck,
    submitDraft,
  };
}
