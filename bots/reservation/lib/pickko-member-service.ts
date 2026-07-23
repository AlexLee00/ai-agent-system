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

    const [nameInput, ph1El, ph2El, ph3El, codeEl] = await Promise.all([
      page.$('input[name="mb_name"]'),
      page.$('#mb_phone1'),
      page.$('#mb_phone2'),
      page.$('#mb_phone3'),
      page.$('#mb_code'),
    ]);
    const missingControls = [
      !nameInput ? 'mb_name' : null,
      !ph1El ? 'mb_phone1' : null,
      !ph2El ? 'mb_phone2' : null,
      !ph3El ? 'mb_phone3' : null,
      !codeEl ? 'mb_code' : null,
    ].filter(Boolean);
    if (missingControls.length > 0) {
      throw new Error(`PICKKO_MEMBER_FORM_INVALID:${missingControls.join(',')}`);
    }

    await nameInput.click({ clickCount: 3 });
    await nameInput.type(customerName, { delay: 50 });
    await delay(300);

    await ph1El.click({ clickCount: 3 });
    await ph1El.type(phone1, { delay: 50 });
    await delay(200);
    await ph2El.click({ clickCount: 3 });
    await ph2El.type(phone2, { delay: 50 });
    await delay(200);
    await ph3El.click({ clickCount: 3 });
    await ph3El.type(phone3, { delay: 50 });
    await delay(300);

    await codeEl.click({ clickCount: 3 });
    await codeEl.type(pin, { delay: 50 });
    await delay(300);

    const birthSet = await page.evaluate((birthDate: string) => {
      const birthInput = document.querySelector('#mb_birth') as HTMLInputElement | null;
      if (!birthInput) return false;
      birthInput.removeAttribute('readonly');
      const w = window as any;
      if (typeof w.jQuery !== 'undefined' && w.jQuery(birthInput).data('datepicker')) {
        w.jQuery(birthInput).datepicker('setDate', new Date(birthDate));
      } else {
        birthInput.value = birthDate;
        birthInput.dispatchEvent(new Event('input', { bubbles: true }));
        birthInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }, reservationDate);
    if (!birthSet) throw new Error('PICKKO_MEMBER_FORM_INVALID:mb_birth');
    await delay(300);

    log('✅ 회원정보 입력완료');
    log(`   이름: ${maskName(customerName)}`);
    log(`   전화: ${maskPhone(phoneNoHyphen)}`);
    log(`   생년월일: ${reservationDate}`);

    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form#memberFrom') as HTMLFormElement | null;
      if (!form) return false;
      HTMLFormElement.prototype.submit.call(form);
      return true;
    });
    if (!submitted) throw new Error('PICKKO_MEMBER_FORM_INVALID:memberFrom');
    await navigation;
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
