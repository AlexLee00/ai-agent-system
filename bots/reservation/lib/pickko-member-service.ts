type PickkoMemberServiceDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
  maskName: (name: string) => string;
  maskPhone: (phone: string) => string;
  publishReservationAlert: (payload: Record<string, unknown>) => Promise<unknown>;
};

export function createPickkoMemberService({
  delay,
  log,
  maskName,
  maskPhone,
  publishReservationAlert,
}: PickkoMemberServiceDeps) {
  async function notifyMemberNameMismatch(
    phoneRaw: string,
    pickkoName: string,
    naverName: string,
    mbNo: string | null = null,
  ) {
    if (!naverName || naverName === '고객' || naverName.length < 2) {
      return { skipped: true, reason: 'invalid_naver_name' };
    }

    const normalizedNaverName = String(naverName || '').trim();
    const normalizedPickkoName = String(pickkoName || '').trim();
    log(`[4.5단계] 픽코 이름: "${normalizedPickkoName}" | 네이버 이름: "${normalizedNaverName}"`);

    if (!normalizedPickkoName || normalizedPickkoName === normalizedNaverName) {
      log('[4.5단계] ✅ 이름 일치 → 추가 조치 없음');
      return { matched: true, mbNo, pickkoName: normalizedPickkoName, naverName: normalizedNaverName };
    }

    const alertMessage =
      `⚠️ 픽코 회원 이름 불일치 감지\n\n` +
      `📞 번호: ${maskPhone(phoneRaw)}\n` +
      `🧾 픽코 이름: ${normalizedPickkoName}\n` +
      `📝 네이버 이름: ${normalizedNaverName}\n\n` +
      `예약은 계속 진행합니다.\n` +
      `회원 정보 수정이 필요하면 마스터가 수동으로 확인해 주세요.`;

    log('[4.5단계] ⚠️ 이름 불일치 감지 → 자동 수정 없이 알림만 발송');
    await publishReservationAlert({
      from_bot: 'andy',
      event_type: 'alert',
      alert_level: 2,
      message: alertMessage,
      payload: {
        type: 'member_name_mismatch',
        phone: phoneRaw,
        pickkoName: normalizedPickkoName,
        naverName: normalizedNaverName,
        mbNo,
      },
    }).catch((error: Error) => {
      log(`[4.5단계] 이름 불일치 알림 발송 실패: ${error.message}`);
    });

    return {
      matched: false,
      mbNo,
      pickkoName: normalizedPickkoName,
      naverName: normalizedNaverName,
      mismatchNotified: true,
    };
  }

  async function registerNewMember(
    page: any,
    phoneNoHyphen: string,
    customerName: string,
    reservationDate: string,
  ) {
    log('\n[3.5단계] 신규 회원 자동 등록');
    const phone1 = phoneNoHyphen.slice(0, 3);
    const phone2 = phoneNoHyphen.slice(3, 7);
    const phone3 = phoneNoHyphen.slice(7);
    const pin = phoneNoHyphen.slice(3);

    await page.goto('https://pickkoadmin.com/member/write.html', { waitUntil: 'domcontentloaded' });
    await delay(2000);

    const nameInput = await page.$('input[name="mb_name"]');
    if (nameInput) {
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(customerName, { delay: 50 });
    }
    await delay(300);

    const ph1El = await page.$('#mb_phone1');
    const ph2El = await page.$('#mb_phone2');
    const ph3El = await page.$('#mb_phone3');
    if (ph1El) {
      await ph1El.click({ clickCount: 3 });
      await ph1El.type(phone1, { delay: 50 });
    }
    await delay(200);
    if (ph2El) {
      await ph2El.click({ clickCount: 3 });
      await ph2El.type(phone2, { delay: 50 });
    }
    await delay(200);
    if (ph3El) {
      await ph3El.click({ clickCount: 3 });
      await ph3El.type(phone3, { delay: 50 });
    }
    await delay(300);

    const codeEl = await page.$('#mb_code');
    if (codeEl) {
      await codeEl.click({ clickCount: 3 });
      await codeEl.type(pin, { delay: 50 });
    }
    await delay(300);

    await page.evaluate((birthDate: string) => {
      const birthInput = document.querySelector('#mb_birth') as HTMLInputElement | null;
      if (!birthInput) return;
      birthInput.removeAttribute('readonly');
      const w = window as any;
      if (typeof w.jQuery !== 'undefined' && w.jQuery(birthInput).data('datepicker')) {
        w.jQuery(birthInput).datepicker('setDate', new Date(birthDate));
      } else {
        birthInput.value = birthDate;
        birthInput.dispatchEvent(new Event('input', { bubbles: true }));
        birthInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, reservationDate);
    await delay(300);

    log('✅ 회원정보 입력완료');
    log(`   이름: ${maskName(customerName)}`);
    log(`   전화: ${maskPhone(phoneNoHyphen)}`);
    log(`   생년월일: ${reservationDate}`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
      page.evaluate(() => {
        const form = document.querySelector('form#memberFrom, form') as HTMLFormElement | null;
        if (form) HTMLFormElement.prototype.submit.call(form);
      }),
    ]);
    await delay(1000);

    const registerUrl = page.url();
    if (registerUrl.includes('/member/view/')) {
      log(`✅ 신규 회원 등록 성공: ${maskName(customerName)} (${maskPhone(phoneNoHyphen)}) → ${registerUrl}`);
    } else {
      const failMsg = `❌ 신규 회원 등록 실패: URL이 /member/view/ 아님 (${registerUrl})`;
      log(failMsg);
      throw new Error(failMsg);
    }

    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
  }

  return {
    notifyMemberNameMismatch,
    registerNewMember,
  };
}
