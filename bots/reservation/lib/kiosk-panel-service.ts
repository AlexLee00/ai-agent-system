type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;

export type CreateKioskPanelServiceDeps = {
  delay: DelayFn;
  log: Logger;
};

export function createKioskPanelService(deps: CreateKioskPanelServiceDeps) {
  const { delay, log } = deps;

  async function isSettingsPanelVisible(page: any) {
    return page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => ((b.textContent || '').trim().includes('설정변경') && (b as HTMLElement).offsetParent !== null));
    });
  }

  async function waitForSettingsPanelClosed(page: any, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const visible = await isSettingsPanelVisible(page);
      if (!visible) return true;
      await delay(250);
    }
    return false;
  }

  async function selectTimeDropdown(page: any, timeStr: string, which: 'start' | 'end') {
    const [hh, mm] = timeStr.split(':').map(Number);
    const isMidnight = hh === 24 || (hh === 0 && mm === 0);
    const isAM = hh < 12;
    const displayH = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
    const ampm = isAM ? '오전' : '오후';
    const timeDisplay = isMidnight ? '자정 12:00' : `${ampm} ${displayH}:${String(mm).padStart(2, '0')}`;

    log(`    드롭다운(${which}): "${timeStr}" → "${timeDisplay}"`);

    const nativeResult = await page.evaluate((targetTime: string) => {
      for (const sel of document.querySelectorAll('select')) {
        const r = (sel as HTMLElement).getBoundingClientRect();
        if (r.left < 1100) continue;
        for (const opt of (sel as HTMLSelectElement).options) {
          if (opt.value === targetTime || opt.text.trim() === targetTime) {
            (sel as HTMLSelectElement).value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { done: true, value: opt.value };
          }
        }
      }
      return { done: false };
    }, timeStr);
    if (nativeResult.done) {
      log(`    native: ${JSON.stringify(nativeResult)}`);
      return true;
    }

    const triggerResult = await page.evaluate((targetWhich: 'start' | 'end') => {
      const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
      const candidates: Array<{ el: Element; txt: string; x: number; y: number; w: number; h: number }> = [];
      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.left < 1100 || r.width < 10 || r.height < 5) continue;
        const txt = (el.textContent || '').trim();
        if (!timeRe.test(txt) || txt.length > 20) continue;
        candidates.push({ el, txt, x: r.left, y: r.top, w: r.width, h: r.height });
      }
      if (candidates.length === 0) return { triggered: false, reason: 'no time text in panel', debug: [] };

      const debug = candidates.map((c) => ({ tag: c.el.tagName, cls: String((c.el as HTMLElement).className || '').slice(0, 60), txt: c.txt, x: Math.round(c.x), y: Math.round(c.y) }));
      const btnCandidates = candidates.filter((c) => c.el.tagName === 'BUTTON');
      const sorted = (btnCandidates.length >= 2 ? btnCandidates : candidates).sort((a, b) => a.x - b.x);
      const target = targetWhich === 'start' ? sorted[0] : sorted[sorted.length - 1];
      (target.el as HTMLElement).click();
      return { triggered: true, txt: target.txt, tag: target.el.tagName, x: Math.round(target.x), debug };
    }, which);

    log(`    패널 트리거(${which}): ${JSON.stringify(triggerResult)}`);
    if (!triggerResult.triggered) return false;
    await delay(600);

    const optResult = await page.evaluate((exactDisplay: string, targetAmpm: string, targetDisplayH: number, targetMm: number) => {
      const minStr = String(targetMm).padStart(2, '0');
      const exact = exactDisplay;
      const noSpace = `${targetAmpm}${targetDisplayH}:${minStr}`;

      for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
        const r = (btn as HTMLElement).getBoundingClientRect();
        if (r.width < 5 || r.height < 3) continue;
        const txt = (btn.textContent || '').trim();
        if (txt === exact || txt === noSpace) {
          (btn as HTMLElement).click();
          return { selected: true, txt, method: 'btn-select' };
        }
      }

      for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
        const r = (li as HTMLElement).getBoundingClientRect();
        if (r.width < 5 || r.height < 3) continue;
        const txt = (li.textContent || '').trim();
        if (txt.length > 15) continue;
        if (txt === exact || txt === noSpace) {
          (li as HTMLElement).click();
          return { selected: true, txt, method: 'li-item' };
        }
      }

      const pattern = new RegExp(`^${targetAmpm}\\s*${targetDisplayH}:${minStr}$`);
      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 5 || r.height < 3) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length > 12) continue;
        if (pattern.test(txt)) {
          (el as HTMLElement).click();
          return { selected: true, txt, method: 'broad' };
        }
      }

      return { selected: false };
    }, timeDisplay, ampm, displayH, mm);

    log(`    드롭다운 옵션: ${JSON.stringify(optResult)}`);
    return optResult.selected;
  }

  async function selectUnavailableStatus(page: any) {
    const nativeResult = await page.evaluate(() => {
      for (const sel of document.querySelectorAll('select')) {
        const r = (sel as HTMLElement).getBoundingClientRect();
        if (r.left < 1100) continue;
        for (const opt of (sel as HTMLSelectElement).options) {
          if (opt.text.includes('예약불가') || opt.value === 'unavailable') {
            (sel as HTMLSelectElement).value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { done: true, text: opt.text };
          }
        }
      }
      return { done: false };
    });
    if (nativeResult.done) {
      log(`    native: ${JSON.stringify(nativeResult)}`);
      return true;
    }

    const triggerResult = await page.evaluate(() => {
      const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
      const statusTexts = ['예약가능', '예약 가능', '-'];

      for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
        const r = (btn as HTMLElement).getBoundingClientRect();
        const txt = (btn.textContent || '').trim();
        if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
        if (timeRe.test(txt)) continue;
        if (statusTexts.includes(txt) || txt === '') {
          (btn as HTMLElement).click();
          return { triggered: true, txt, tag: btn.tagName, x: Math.round(r.left), y: Math.round(r.top), method: 'btn-form-control' };
        }
      }

      for (const el of document.querySelectorAll('*')) {
        if ((el as HTMLElement).children.length > 0) continue;
        const txt = (el.textContent || '').trim();
        if (txt !== '예약상태') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.left < 1100 || r.top < 200) continue;
        const rowBtns = Array.from(document.querySelectorAll('button.form-control, button[class*="form-control"]')).filter((b) => {
          const br = (b as HTMLElement).getBoundingClientRect();
          return br.left > 1100 && Math.abs(br.top - r.top) < 40 && !timeRe.test((b.textContent || '').trim());
        });
        if (rowBtns.length > 0) {
          (rowBtns[0] as HTMLElement).click();
          const br = (rowBtns[0] as HTMLElement).getBoundingClientRect();
          return { triggered: true, txt: (rowBtns[0].textContent || '').trim(), method: 'label-adjacent', x: Math.round(br.left), y: Math.round(br.top) };
        }
      }

      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const txt = (el.textContent || '').trim();
        if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
        if (timeRe.test(txt)) continue;
        if (statusTexts.includes(txt) || (txt.includes('예약가능') && txt.length < 15)) {
          (el as HTMLElement).click();
          return { triggered: true, txt, tag: el.tagName, x: Math.round(r.left), y: Math.round(r.top), method: 'fallback' };
        }
      }
      return { triggered: false };
    });

    log(`    예약상태 트리거: ${JSON.stringify(triggerResult)}`);
    if (!triggerResult.triggered) return false;
    await delay(600);

    const optResult = await page.evaluate(() => {
      const unavail = ['예약불가', '예약 불가'];
      for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
        const r = (btn as HTMLElement).getBoundingClientRect();
        const txt = (btn.textContent || '').trim();
        if (r.width < 5 || r.height < 3) continue;
        if (unavail.includes(txt)) {
          (btn as HTMLElement).click();
          return { selected: true, txt, method: 'btn-select', x: Math.round(r.left) };
        }
      }
      for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
        const r = (li as HTMLElement).getBoundingClientRect();
        const txt = (li.textContent || '').trim();
        if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
        if (unavail.includes(txt)) {
          (li as HTMLElement).click();
          return { selected: true, txt, method: 'li-item', x: Math.round(r.left) };
        }
      }
      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const txt = (el.textContent || '').trim();
        if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
        if (unavail.includes(txt)) {
          (el as HTMLElement).click();
          return { selected: true, txt, x: Math.round(r.left), y: Math.round(r.top) };
        }
      }
      return { selected: false };
    });

    log(`    예약불가 옵션: ${JSON.stringify(optResult)}`);
    return optResult.selected;
  }

  async function selectAvailableStatus(page: any) {
    const nativeResult = await page.evaluate(() => {
      for (const sel of document.querySelectorAll('select')) {
        const r = (sel as HTMLElement).getBoundingClientRect();
        if (r.left < 1100) continue;
        for (const opt of (sel as HTMLSelectElement).options) {
          if (opt.text.includes('예약가능') || opt.value === 'available') {
            (sel as HTMLSelectElement).value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { done: true, text: opt.text };
          }
        }
      }
      return { done: false };
    });
    if (nativeResult.done) {
      log(`    native: ${JSON.stringify(nativeResult)}`);
      return true;
    }

    const triggerResult = await page.evaluate(() => {
      const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
      const unavailTexts = ['예약불가', '예약 불가'];

      for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
        const r = (btn as HTMLElement).getBoundingClientRect();
        const txt = (btn.textContent || '').trim();
        if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
        if (timeRe.test(txt)) continue;
        if (unavailTexts.some((s) => txt.includes(s))) {
          (btn as HTMLElement).click();
          return { triggered: true, txt, method: 'btn-form-control' };
        }
      }

      for (const el of document.querySelectorAll('*')) {
        if ((el as HTMLElement).children.length > 0) continue;
        const txt = (el.textContent || '').trim();
        if (txt !== '예약상태') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.left < 1100 || r.top < 200) continue;
        const rowBtns = Array.from(document.querySelectorAll('button.form-control, button[class*="form-control"]')).filter((b) => {
          const br = (b as HTMLElement).getBoundingClientRect();
          return br.left > 1100 && Math.abs(br.top - r.top) < 40 && !timeRe.test((b.textContent || '').trim());
        });
        if (rowBtns.length > 0) {
          (rowBtns[0] as HTMLElement).click();
          return { triggered: true, txt: (rowBtns[0].textContent || '').trim(), method: 'label-adjacent' };
        }
      }

      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const txt = (el.textContent || '').trim();
        if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
        if (/오[전후]/.test(txt)) continue;
        if (txt.includes('예약불가') && txt.length < 15) {
          (el as HTMLElement).click();
          return { triggered: true, txt, tag: el.tagName, method: 'fallback' };
        }
      }
      return { triggered: false };
    });

    log(`    예약가능 상태 트리거: ${JSON.stringify(triggerResult)}`);
    if (!triggerResult.triggered) return false;
    await delay(600);

    const optResult = await page.evaluate(() => {
      const available = ['예약가능', '예약 가능'];
      for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
        const r = (btn as HTMLElement).getBoundingClientRect();
        const txt = (btn.textContent || '').trim();
        if (r.width < 5 || r.height < 3) continue;
        if (available.includes(txt)) {
          (btn as HTMLElement).click();
          return { selected: true, txt, method: 'btn-select' };
        }
      }
      for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
        const r = (li as HTMLElement).getBoundingClientRect();
        const txt = (li.textContent || '').trim();
        if (r.width < 5 || r.height < 3) continue;
        if (available.includes(txt)) {
          (li as HTMLElement).click();
          return { selected: true, txt, method: 'li-item' };
        }
      }
      for (const el of document.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const txt = (el.textContent || '').trim();
        if (r.width < 5 || r.height < 3) continue;
        if (available.includes(txt)) {
          (el as HTMLElement).click();
          return { selected: true, txt, method: 'fallback' };
        }
      }
      return { selected: false };
    });

    log(`    예약가능 옵션: ${JSON.stringify(optResult)}`);
    return optResult.selected;
  }

  async function fillUnavailablePopup(page: any, date: string, start: string, end: string) {
    log(`  📋 팝업 설정: ${date} ${start}~${end} 예약불가`);
    await delay(800);
    const popupVisible = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => ((b.textContent || '').trim() === '설정변경' && (b as HTMLElement).offsetParent !== null));
    });
    log(`  패널 가시성(설정변경 버튼): ${popupVisible}`);

    await page.evaluate((targetDate: string) => {
      const dateInputs = document.querySelectorAll('input[type="date"], input[placeholder*="날짜"], input[class*="date"]');
      dateInputs.forEach((el) => {
        const input = el as HTMLInputElement;
        if (input.value !== targetDate) {
          input.value = targetDate;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, date);

    const startSet = await selectTimeDropdown(page, start, 'start');
    log(`  시작시간 설정: ${startSet}`);
    await delay(500);
    const endSet = await selectTimeDropdown(page, end, 'end');
    log(`  종료시간 설정: ${endSet}`);
    await delay(500);
    const statusSet = await selectUnavailableStatus(page);
    log(`  예약불가 설정: ${statusSet}`);
    await delay(500);
    if (!statusSet) {
      log('  ⚠️ 예약불가 상태 설정 실패');
      return false;
    }

    const saved = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim();
        if ((text === '설정변경' || text.includes('설정변경')) && (btn as HTMLElement).offsetParent !== null) {
          (btn as HTMLElement).click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });
    log(`  설정변경 클릭: ${JSON.stringify(saved)}`);
    if (!saved.clicked) return false;

    const panelClosed = await waitForSettingsPanelClosed(page, 8000);
    if (!panelClosed) {
      log('  ⚠️ 설정 패널이 닫히지 않음 — 반영 실패 가능성');
      return false;
    }
    await delay(2500);
    log('  ✅ 설정변경 완료 (패널 닫힘 확인)');
    return true;
  }

  async function fillAvailablePopup(page: any, date: string, start: string, end: string) {
    log(`  📋 팝업 설정: ${date} ${start}~${end} 예약가능`);
    await delay(800);
    const popupVisible = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => ((b.textContent || '').trim() === '설정변경' && (b as HTMLElement).offsetParent !== null));
    });
    log(`  패널 가시성(설정변경 버튼): ${popupVisible}`);

    await page.evaluate((targetDate: string) => {
      const dateInputs = document.querySelectorAll('input[type="date"], input[placeholder*="날짜"], input[class*="date"]');
      dateInputs.forEach((el) => {
        const input = el as HTMLInputElement;
        if (input.value !== targetDate) {
          input.value = targetDate;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, date);

    const startSet = await selectTimeDropdown(page, start, 'start');
    log(`  시작시간 설정: ${startSet}`);
    await delay(500);
    const endSet = await selectTimeDropdown(page, end, 'end');
    log(`  종료시간 설정: ${endSet}`);
    await delay(500);
    const statusSet = await selectAvailableStatus(page);
    log(`  예약가능 설정: ${statusSet}`);
    await delay(500);
    if (!statusSet) {
      log('  ⚠️ 예약가능 상태 설정 실패');
      return false;
    }

    const saved = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim();
        if ((text === '설정변경' || text.includes('설정변경')) && (btn as HTMLElement).offsetParent !== null) {
          (btn as HTMLElement).click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });
    log(`  설정변경 클릭: ${JSON.stringify(saved)}`);
    if (!saved.clicked) return false;

    const panelClosed = await waitForSettingsPanelClosed(page, 8000);
    if (!panelClosed) {
      log('  ⚠️ 설정 패널이 닫히지 않음 — 예약가능 반영 실패 가능성');
      return false;
    }
    await delay(2500);
    log('  ✅ 설정변경 완료 (예약가능, 패널 닫힘 확인)');
    return true;
  }

  return {
    isSettingsPanelVisible,
    waitForSettingsPanelClosed,
    selectTimeDropdown,
    selectUnavailableStatus,
    selectAvailableStatus,
    fillUnavailablePopup,
    fillAvailablePopup,
  };
}
