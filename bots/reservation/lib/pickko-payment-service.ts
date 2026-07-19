type PickkoPaymentServiceDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
  stepTimeoutMs?: number;
};

type PaymentStepError = Error & {
  stageCode?: string;
  paymentStep?: string;
};

type PickkoPaymentSnapshot = {
  od_add_item_price: string | null;
  pay_list_price: string | null;
  pay_list_prices: string[];
  serialized_price_values: string[];
  od_total_price3: string;
  has_top_price: boolean;
  has_total_price: boolean;
  has_payment_form: boolean;
};

function norm(s: unknown) {
  return String(s ?? '').replace(/[\s,]/g, '').trim();
}

function normalizePaymentSnapshot(value: unknown): PickkoPaymentSnapshot {
  const snapshot = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    od_add_item_price: snapshot.od_add_item_price == null ? null : String(snapshot.od_add_item_price),
    pay_list_price: snapshot.pay_list_price == null ? null : String(snapshot.pay_list_price),
    pay_list_prices: Array.isArray(snapshot.pay_list_prices)
      ? snapshot.pay_list_prices.map((item) => String(item ?? ''))
      : (snapshot.pay_list_price == null ? [] : [String(snapshot.pay_list_price)]),
    serialized_price_values: Array.isArray(snapshot.serialized_price_values)
      ? snapshot.serialized_price_values.map((item) => String(item ?? ''))
      : [],
    od_total_price3: String(snapshot.od_total_price3 ?? ''),
    has_top_price: snapshot.has_top_price === true,
    has_total_price: snapshot.has_total_price === true,
    has_payment_form: snapshot.has_payment_form === true,
  };
}

export async function setPickkoPaymentPriceZero(page: any): Promise<boolean> {
  const changed = await page.evaluate(() => {
    const input = document.querySelector('#od_add_item_price') as HTMLInputElement | null;
    if (!input) return false;

    input.focus?.();
    input.value = '0';
    for (const type of ['input', 'change', 'keyup']) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  });
  return changed === true;
}

export function createPickkoPaymentService({
  delay,
  log,
  stepTimeoutMs,
}: PickkoPaymentServiceDeps) {
  const configuredTimeoutMs = Number(stepTimeoutMs ?? process.env.PICKKO_PAYMENT_STEP_TIMEOUT_MS ?? 60_000);
  const resolvedStepTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 60_000;

  async function runPaymentStep<T>(step: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    log(`⏱️ [payment-step:start] ${step}`);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(
            `[PAYMENT_STEP_TIMEOUT] ${step} exceeded ${resolvedStepTimeoutMs}ms`,
          ) as PaymentStepError;
          error.stageCode = 'PAYMENT';
          error.paymentStep = step;
          reject(error);
        }, resolvedStepTimeoutMs);
      });
      return await Promise.race([action(), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      log(`⏱️ [payment-step:end] ${step} ${Date.now() - startedAt}ms`);
    }
  }

  async function setTopPriceZero(page: any) {
    return runPaymentStep('price_zero', () => setPickkoPaymentPriceZero(page));
  }

  async function setMemo(page: any): Promise<boolean> {
    try {
      return await runPaymentStep('memo', async () => (await page.evaluate(() => {
        const input = document.querySelector('#od_memo') as HTMLInputElement | null;
        if (!input) return false;
        input.value = '네이버예약 결제';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })) === true);
    } catch (e: any) {
      log(`⚠️ 주문메모 입력 실패: ${e.message}`);
      return false;
    }
  }

  async function clickCashMouse(page: any): Promise<boolean> {
    try {
      const isChecked = await runPaymentStep('cash_select', async () => (await page.evaluate(() => {
        const input = document.querySelector('#pay_type1_2') as HTMLInputElement | null;
        const label = document.querySelector('label[for="pay_type1_2"]') as HTMLElement | null;
        if (!input || !label) return false;
        label.click();
        return input.checked;
      })) === true);
      log(`💳 현금 클릭 결과: checked=${isChecked}`);
      return isChecked;
    } catch (e: any) {
      log(`⚠️ 현금 선택 실패: ${e.message}`);
      return false;
    }
  }

  async function readTotals(page: any): Promise<PickkoPaymentSnapshot> {
    const snapshot = await runPaymentStep<unknown>('read_totals', () => page.evaluate(() => {
      const topPrice = document.querySelector('#od_add_item_price') as HTMLInputElement | null;
      const totalPrice = document.querySelector('#od_total_price3');
      const paymentRoot = document.querySelector('#order_write');
      const paymentForm = topPrice?.closest('form')
        || (paymentRoot?.tagName === 'FORM' ? paymentRoot as HTMLFormElement : paymentRoot?.querySelector('form'));
      const payListPrices = Array.from(
        document.querySelectorAll('input[name*="pay_list"][name*="price"]'),
      ).map((input) => (input as HTMLInputElement).value ?? '');
      const serializedPriceValues = paymentForm
        ? Array.from(new FormData(paymentForm).entries())
          .filter(([name]) => {
            const normalizedName = String(name || '').toLowerCase();
            return normalizedName === 'od_add_item_price'
              || normalizedName === 'od_total_price'
              || (normalizedName.includes('pay_list') && normalizedName.includes('price'));
          })
          .map(([, value]) => String(value ?? ''))
        : [];
      return {
        od_add_item_price: topPrice?.value ?? null,
        pay_list_price: payListPrices[0] ?? null,
        pay_list_prices: payListPrices,
        serialized_price_values: serializedPriceValues,
        od_total_price3: (totalPrice?.textContent || '').trim(),
        has_top_price: topPrice !== null,
        has_total_price: totalPrice !== null,
        has_payment_form: paymentForm != null,
      };
    }));
    return normalizePaymentSnapshot(snapshot);
  }

  async function waitTotalZeroStable(page: any) {
    const isOptionalZero = (value: unknown) => {
      const normalized = norm(value);
      return normalized === '' || normalized === '0';
    };
    const isZeroSnapshot = (snapshot: any) => (
      snapshot?.has_top_price === true
      && snapshot?.has_total_price === true
      && norm(snapshot?.od_add_item_price) === '0'
      && norm(snapshot?.od_total_price3) === '0'
      && Array.isArray(snapshot?.pay_list_prices)
      && snapshot.pay_list_prices.length > 0
      && snapshot.pay_list_prices.every(isOptionalZero)
      && snapshot?.has_payment_form === true
      && Array.isArray(snapshot?.serialized_price_values)
      && snapshot.serialized_price_values.length > 0
      && snapshot.serialized_price_values.every(isOptionalZero)
    );
    for (let i = 0; i < 10; i++) {
      await delay(250);
      const s1 = await readTotals(page);
      await delay(250);
      const s2 = await readTotals(page);
      log(`🔁 총액 안정성 체크#${i + 1}: s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
      if (isZeroSnapshot(s1) && isZeroSnapshot(s2)) return { ok: true, snap: s2 };
    }
    const last = await readTotals(page);
    return { ok: false, snap: last };
  }

  async function clickPayOrderMouse(page: any): Promise<boolean> {
    return runPaymentStep('submit', async () => (await page.evaluate(() => {
      const button = document.querySelector('#pay_order') as HTMLElement | null;
      if (!button) return false;
      button.click();
      return true;
    })) === true);
  }

  async function modalClosed(page: any): Promise<boolean> {
    return runPaymentStep('post_submit_modal_state', async () => (
      (await page.evaluate(() => !document.querySelector('#order_write'))) === true
    ));
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
    log('PICKKO_PAYMENT_STAGE_ENTERED');
    const payBtnClicked = await runPaymentStep('open_payment_modal', async () => (await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')) as any[];
      for (const b of btns) {
        const t = (b.innerText || b.value || b.textContent || '').trim();
        if (t === '결제하기') {
          b.click();
          return true;
        }
      }
      return false;
    })) === true);
    log(payBtnClicked ? '✅ 상세 화면 결제하기 클릭' : '⚠️ 상세 화면 결제하기 버튼을 못 찾음');
    if (!payBtnClicked) {
      throw buildStageError('PAYMENT', '[PAYMENT_BUTTON_NOT_FOUND] 상세 화면 결제하기 버튼을 찾지 못함');
    }

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
        if (!priceOk) {
          throw buildStageError('PAYMENT', '[PAYMENT_PRICE_INPUT_MISSING] 가격 입력 필드를 찾지 못함');
        }
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
    if (!cashOk) {
      throw buildStageError('PAYMENT', '[PAYMENT_CASH_SELECT_FAILED] 현금 결제수단 선택이 확인되지 않음');
    }

    await delay(300);

    if (!skipPriceZero) {
      const reasserted = await setTopPriceZero(page);
      if (!reasserted) {
        throw buildStageError('PAYMENT', '[PAYMENT_PRICE_INPUT_MISSING] 제출 직전 가격 입력 필드를 찾지 못함');
      }
      const stable = await waitTotalZeroStable(page);
      if (!stable.ok) {
        throw buildStageError(
          'PAYMENT_TOTAL_VALIDATION_FAILED',
          `결제 중단: 제출 직전 총 결제금액이 0이 아님 (od_total_price3=${stable.snap?.od_total_price3})`,
        );
      }
    }

    log('PICKKO_PAYMENT_SUBMIT_STARTED attempt=1');
    let paySubmitClicked = false;
    try {
      paySubmitClicked = await clickPayOrderMouse(page);
    } catch (e: any) {
      throw buildStageError(
        'PAYMENT',
        `[PAYMENT_OUTCOME_UNKNOWN] 결제 제출 호출 결과를 확인하지 못함: ${e.message}`,
      );
    }
    if (!paySubmitClicked) {
      throw buildStageError('PAYMENT', '[PAYMENT_SUBMIT_BUTTON_NOT_FOUND] 모달 결제하기 버튼을 찾지 못함');
    }
    log(paySubmitClicked ? '✅ 모달 결제하기 클릭' : '⚠️ 모달 결제하기 버튼 클릭 실패');
    let closed = false;
    let after = '';
    let finalConfirm: { clicked: boolean; text?: string } = { clicked: false };
    try {
      await delay(600);
      closed = await modalClosed(page);
      const postSubmitTotal = await runPaymentStep<unknown>('post_submit_total', () => (
        page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim())
      ));
      after = String(postSubmitTotal ?? '');
      log(`🔍 클릭 후 상태: modalClosed=${closed}, od_total_price3=${after}`);

      await delay(200);
      finalConfirm = await runPaymentStep('confirm_result_popup', () => page.evaluate(() => {
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
      }));
    } catch (e: any) {
      throw buildStageError(
        'PAYMENT',
        `[PAYMENT_OUTCOME_UNKNOWN] 결제 제출 후 상태를 확인하지 못함: ${e.message}`,
      );
    }
    log(`결제완료 팝업 확인: ${JSON.stringify(finalConfirm)}`);
    await delay(500);

    return {
      payBtnClicked,
      payModalResult,
      paySubmitClicked,
      finalConfirm,
      submissionState: 'submitted_unverified',
      modalClosed: closed,
    };
  }

  return {
    processPaymentStep,
  };
}
