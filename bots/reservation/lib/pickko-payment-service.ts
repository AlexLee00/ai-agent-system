type PickkoPaymentServiceDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
};

function norm(s: unknown) {
  return String(s ?? '').replace(/[\s,]/g, '').trim();
}

export function createPickkoPaymentService({ delay, log }: PickkoPaymentServiceDeps) {
  async function setTopPriceZero(page: any) {
    const priceInp = await page.$('#od_add_item_price');
    if (!priceInp) return false;

    await priceInp.click({ clickCount: 3 });
    await delay(120);
    try { await page.keyboard.press('Meta+A'); } catch {}
    try { await page.keyboard.press('Control+A'); } catch {}
    await delay(80);
    for (let k = 0; k < 8; k++) {
      await page.keyboard.press('Backspace');
      await delay(40);
    }
    await delay(80);
    await page.keyboard.type('0', { delay: 80 });
    await delay(150);
    await page.mouse.click(20, 20);
    return true;
  }

  async function setMemo(page: any) {
    try {
      await page.$eval('#od_memo', (inp: any) => {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.value = '네이버예약 결제';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return true;
    } catch (e: any) {
      log(`⚠️ 주문메모 입력 실패: ${e.message}`);
      return false;
    }
  }

  async function clickCashMouse(page: any) {
    try {
      await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 5000 });
      const labelHandle = await page.$('label[for="pay_type1_2"]');
      if (!labelHandle) throw new Error('현금 label 핸들 없음');

      await page.evaluate(() => {
        const el = document.querySelector('label[for="pay_type1_2"]');
        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      });
      await delay(200);

      const box = await labelHandle.boundingBox();
      if (!box) throw new Error('현금 label boundingBox 없음');

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await delay(150);

      const isChecked = await page.evaluate(() => (document.querySelector('#pay_type1_2') as HTMLInputElement | null)?.checked ?? false);
      log(`💳 현금 클릭 결과: checked=${isChecked}`);
      return isChecked;
    } catch (e: any) {
      log(`⚠️ 현금 선택 실패: ${e.message}`);
      return false;
    }
  }

  async function readTotals(page: any) {
    return page.evaluate(() => {
      const v1 = (document.querySelector('#od_add_item_price') as HTMLInputElement | null)?.value ?? null;
      const v2 = (document.querySelector('input[name*="pay_list"][name*="price"]') as HTMLInputElement | null)?.value ?? null;
      const total = (document.querySelector('#od_total_price3')?.textContent || '').trim();
      return { od_add_item_price: v1, pay_list_price: v2, od_total_price3: total };
    });
  }

  async function waitTotalZeroStable(page: any) {
    for (let i = 0; i < 10; i++) {
      await delay(250);
      const s1 = await readTotals(page);
      await delay(250);
      const s2 = await readTotals(page);
      log(`🔁 총액 안정성 체크#${i + 1}: s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
      if (norm(s1.od_total_price3) === '0' && norm(s2.od_total_price3) === '0') return { ok: true, snap: s2 };
    }
    const last = await readTotals(page);
    return { ok: false, snap: last };
  }

  async function preClickReassertZero(page: any) {
    try {
      await page.$eval('#od_add_item_price', (inp: any) => {
        inp.setAttribute('price', '0');
        inp.setAttribute('ea', '0');
      });
    } catch {}

    try {
      await page.$eval('#od_total_price', (inp: any) => { inp.value = '0'; });
    } catch {}

    try {
      const priceInp = await page.$('#od_add_item_price');
      if (priceInp) {
        await priceInp.click({ clickCount: 3 });
        await delay(80);
        try { await page.keyboard.press('Meta+A'); } catch {}
        try { await page.keyboard.press('Control+A'); } catch {}
        for (let k = 0; k < 8; k++) {
          await page.keyboard.press('Backspace');
          await delay(30);
        }
        await page.keyboard.type('0', { delay: 50 });
        await delay(80);
        await page.mouse.click(20, 20);
      }
    } catch {}
  }

  async function clickPayOrderMouse(page: any) {
    await page.waitForSelector('#pay_order', { timeout: 5000 });
    const h = await page.$('#pay_order');
    if (!h) throw new Error('#pay_order 핸들 없음');
    await page.evaluate(() => document.querySelector('#pay_order')?.scrollIntoView({ block: 'center' }));
    await delay(150);
    const box = await h.boundingBox();
    if (!box) throw new Error('#pay_order boundingBox 없음');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  }

  async function modalClosed(page: any) {
    return page.evaluate(() => !document.querySelector('#order_write'));
  }

  async function processPaymentStep(
    page: any,
    {
      skipPriceZero,
      buildStageError,
    }: {
      skipPriceZero: boolean;
      buildStageError: (code: string, message: string) => Error;
    },
  ) {
    const payBtnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')) as any[];
      for (const b of btns) {
        const t = (b.innerText || b.value || b.textContent || '').trim();
        if (t === '결제하기') {
          b.click();
          return true;
        }
      }
      return false;
    });
    log(payBtnClicked ? '✅ 상세 화면 결제하기 클릭' : '⚠️ 상세 화면 결제하기 버튼을 못 찾음');

    await delay(1200);

    let cashOk = false;
    let priceOk = false;
    let memoOk = false;
    let totalText = '';

    if (skipPriceZero) {
      log('🧾 [8-2] 실제 금액 현금 결제 진행');
      const snap = await readTotals(page);
      totalText = snap?.od_total_price3 ?? '';
      log(`🔎 현재 결제금액: ${totalText}`);
      cashOk = await clickCashMouse(page);
      await delay(300);
    } else {
      for (let attempt = 1; attempt <= 2; attempt++) {
        log(`🧾 결제 입력 시도 #${attempt}`);

        priceOk = await setTopPriceZero(page);
        await delay(250);
        memoOk = await setMemo(page);
        await delay(250);
        cashOk = await clickCashMouse(page);
        await delay(250);

        const stable = await waitTotalZeroStable(page);
        totalText = stable.snap?.od_total_price3 ?? '';
        log(`🔎 결제 입력 후 스냅샷: ${JSON.stringify(stable.snap)}`);
        if (stable.ok) break;
        log(`⚠️ 총 결제금액이 0으로 안정화되지 않음(현재 ${totalText}). 재시도합니다...`);
      }
    }

    const payModalResult = {
      cashOk,
      priceOk,
      memoOk,
      totalText,
      note: '결제 사유(od_add_item_dsc)는 자동 고정',
    };

    log(`🧾 결제 모달 입력 결과: ${JSON.stringify(payModalResult)}`);

    if (!skipPriceZero && norm(payModalResult.totalText) !== '0') {
      throw buildStageError('PAYMENT_TOTAL_VALIDATION_FAILED', `결제 중단: 총 결제금액이 0이 아님 (od_total_price3=${payModalResult.totalText})`);
    }

    await delay(300);

    let paySubmitClicked = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`🧾 결제하기 클릭 시도 #${attempt}`);
      if (!skipPriceZero) await preClickReassertZero(page);

      try {
        paySubmitClicked = await clickPayOrderMouse(page);
      } catch (e: any) {
        log(`⚠️ 결제하기 클릭 실패: ${e.message}`);
        paySubmitClicked = false;
      }

      await delay(600);

      const closed = await modalClosed(page);
      const after = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
      log(`🔍 클릭 후 상태: modalClosed=${closed}, od_total_price3=${after}`);

      if (closed) break;
      if (skipPriceZero) break;
      if (norm(after) === '0') break;

      log('⚠️ 결제 클릭 후 총액이 원복된 것으로 보임. 0 재입력 후 재시도합니다...');
      await delay(400);
    }

    log(paySubmitClicked ? '✅ 모달 결제하기 클릭' : '⚠️ 모달 결제하기 버튼 클릭 실패');
    await delay(800);

    const finalConfirm = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')) as any[];
      const confirmBtn = btns.find((b) => {
        const t = (b.textContent || b.value || '').trim();
        return t === '확인' || t === 'OK';
      });
      if (confirmBtn) {
        confirmBtn.click();
        return { clicked: true, text: (confirmBtn.textContent || confirmBtn.value || '').trim() };
      }
      return { clicked: false };
    });
    log(`결제완료 팝업 확인: ${JSON.stringify(finalConfirm)}`);
    await delay(500);

    return {
      payBtnClicked,
      payModalResult,
      paySubmitClicked,
      finalConfirm,
    };
  }

  return {
    processPaymentStep,
  };
}
