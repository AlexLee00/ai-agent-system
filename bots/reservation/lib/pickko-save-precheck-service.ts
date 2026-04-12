type SavePrecheckDeps = {
  log: (message: string) => void;
  buildStageError: (code: string, message: string) => Error;
};

export function createPickkoSavePrecheckService({
  log,
  buildStageError,
}: SavePrecheckDeps) {
  async function runSavePrecheck(page: any) {
    const sanity = await page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

      const startDate = clean((document.querySelector('#start_date') as HTMLInputElement | null)?.value);
      const startTime = clean((document.querySelector('#start_time') as HTMLInputElement | null)?.value);
      const endDate = clean((document.querySelector('#end_date') as HTMLInputElement | null)?.value);
      const endTime = clean((document.querySelector('#end_time') as HTMLInputElement | null)?.value);

      let priceText: string | null = null;
      let useTimeText: string | null = null;

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
        const fallback = clean(
          (document.querySelector('#study_price') as HTMLElement | null)?.innerText ||
          document.querySelector('#study_price')?.textContent,
        );
        if (fallback) priceText = fallback;
      }

      const parseMoney = (s: string | null) => {
        if (!s) return null;
        const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : null;
      };

      const priceNum = parseMoney(priceText);
      const badAmount = (typeof priceText === 'string' && priceText.includes('-')) || (priceNum !== null && priceNum < 0);
      const missingTime = !startTime || !endTime;

      const toTs = (d: string, t: string) => {
        if (!d || !t) return null;
        const ms = Date.parse(`${d}T${t}:00`);
        return Number.isFinite(ms) ? ms : null;
      };

      const ts1 = toTs(startDate, startTime);
      const ts2 = toTs(endDate || startDate, endTime);

      let durationMin: number | null = null;
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
    });

    log(`🧪 저장 전 확인: ${JSON.stringify(sanity)}`);

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

    const submitClicked = await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"][value="작성하기"]') as HTMLInputElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);

    if (!submitClicked) {
      log('⚠️ 작성하기 버튼 미발견 → form.submit() 폴백');
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) HTMLFormElement.prototype.submit.call(form);
      }).catch(() => {});
    }

    log('✅ 작성하기 클릭 완료');
    return { submitClicked };
  }

  return {
    runSavePrecheck,
    submitDraft,
  };
}
