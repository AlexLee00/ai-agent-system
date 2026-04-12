type PickkoMemberSelectionDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
  maskName: (name: string) => string;
  maskPhone: (phone: string) => string;
  sendErrorNotification: (message: string, context?: Record<string, unknown>) => Promise<unknown>;
  buildStageError: (code: string, message: string) => Error;
  registerNewMember: (page: any, phone: string, customerName: string, reservationDate: string) => Promise<unknown>;
};

export function createPickkoMemberSelectionService({
  delay,
  log,
  maskName,
  maskPhone,
  sendErrorNotification,
  buildStageError,
  registerNewMember,
}: PickkoMemberSelectionDeps) {
  function formatPhoneForComparison(phone: string) {
    if (!phone || phone.length !== 11) return phone;
    return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
  }

  async function runMemberSearch(page: any, phoneNoHyphen: string) {
    log('\n[3단계] 회원 검색');
    await page.evaluate((phone: string) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      let targetInput: HTMLInputElement | null = null;
      for (const input of Array.from(inputs)) {
        const el = input as HTMLInputElement;
        if (el.placeholder && (el.placeholder.includes('이름') || el.placeholder.includes('검색'))) {
          targetInput = el;
          break;
        }
      }
      if (!targetInput && inputs.length > 0) targetInput = inputs[inputs.length - 1] as HTMLInputElement;

      if (targetInput) {
        targetInput.value = phone;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    }, phoneNoHyphen);

    log(`✅ 전화번호(${phoneNoHyphen}) 입력 완료`);
    await delay(3000);
  }

  async function verifyAndSelectMember(
    page: any,
    {
      phoneNoHyphen,
      customerName,
      date,
    }: {
      phoneNoHyphen: string;
      customerName: string;
      date: string;
    },
    retryCount = 0,
  ): Promise<{ name: string; phone: string }> {
    if (retryCount >= 5) {
      const errorMsg = '❌ 회원정보 검증 실패: 5회 시도 후에도 정보 불일치';
      log(errorMsg);
      await sendErrorNotification(errorMsg, {
        step: '4단계',
        phone: phoneNoHyphen,
        retries: retryCount,
      });
      throw buildStageError('MEMBER_SELECT_FAILED', errorMsg);
    }

    await page.evaluate(() => {
      const btn = document.querySelector('a#mb_select_btn') as HTMLElement | null;
      if (btn) {
        btn.click();
        return;
      }
      const links = document.querySelectorAll('a.btn_box');
      for (const a of Array.from(links)) {
        if ((a.textContent || '').includes('회원 선택')) {
          (a as HTMLElement).click();
          return;
        }
      }
    });
    await delay(2000);

    const hasMember = await page.evaluate(() => !!document.querySelector('a.mb_select'));
    if (!hasMember && retryCount >= 1) {
      const failMsg = `❌ 신규 등록 후에도 회원 검색 안됨 (${phoneNoHyphen}) → 픽코 수동 확인 필요`;
      log(failMsg);
      throw buildStageError('MEMBER_REGISTER_OR_SEARCH_FAILED', failMsg);
    }

    if (!hasMember && retryCount === 0) {
      log(`⚠️ 픽코 미등록 고객(${phoneNoHyphen}) → 신규 회원 자동 등록 시작`);
      await page.keyboard.press('Escape');
      await delay(500);
      await registerNewMember(page, phoneNoHyphen, customerName, date);
      log('\n[3단계 재실행] 신규 등록 후 재검색');
      await runMemberSearch(page, phoneNoHyphen);
      return verifyAndSelectMember(page, { phoneNoHyphen, customerName, date }, 1);
    }

    const memberSelectResult = await page.evaluate(() => {
      const selectBtn = document.querySelector('a.mb_select') as HTMLElement | null;
      if (selectBtn) {
        selectBtn.click();
        return true;
      }
      return false;
    });

    if (!memberSelectResult) {
      log('⚠️ 모달 내 선택 버튼 실패');
    }
    await delay(2000);

    const memberInfo = await page.evaluate(() => {
      const mbInfo = document.querySelector('span#mb_info');
      if (!mbInfo) return null;
      const text = (mbInfo.textContent || '').trim();
      const match = text.match(/(.+?)\((.+?)\)/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        phone: match[2].trim().replace(/-/g, ''),
      };
    });

    if (!memberInfo) {
      log(`⚠️ 회원정보 추출 실패 (시도 ${retryCount + 1}/5)`);
      return verifyAndSelectMember(page, { phoneNoHyphen, customerName, date }, retryCount + 1);
    }

    log(`📋 선택된 회원: ${maskName(memberInfo.name)}(${maskPhone(memberInfo.phone)})`);

    if (phoneNoHyphen !== memberInfo.phone) {
      log('❌ 전화번호 불일치');
      log(`   입력: ${formatPhoneForComparison(phoneNoHyphen)}`);
      log(`   선택: ${formatPhoneForComparison(memberInfo.phone)}`);
      log(`⏳ 회원 선택 다시 수행... (시도 ${retryCount + 1}/5)`);
      return verifyAndSelectMember(page, { phoneNoHyphen, customerName, date }, retryCount + 1);
    }

    log(`✅ 회원정보 검증 완료 (시도 ${retryCount + 1}/5)`);
    log(`   이름: ${maskName(memberInfo.name)}`);
    log(`   전화: ${maskPhone(memberInfo.phone)}`);
    return memberInfo;
  }

  return {
    formatPhoneForComparison,
    runMemberSearch,
    verifyAndSelectMember,
  };
}
