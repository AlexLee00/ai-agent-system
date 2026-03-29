#!/usr/bin/env node

/**
 * 픽코 예약 등록 (외부 모니터 + 팝업 자동 처리)
 * 010-3500-0586 / 2026-02-22 / 02:30~03:00 / A1룸
 * 
 * ✅ VALIDATION_RULES.md에 정의된 정규식 변환 규칙 적용
 * ✅ lib/validation.js 라이브러리 사용
 */

const puppeteer = require('puppeteer');
const path = require('path');
const { spawn } = require('child_process');
const { transformAndNormalizeData, validateTimeRange } = require('../../lib/validation');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { maskPhone, maskName } = require('../../lib/formatting');
const { acquirePickkoLock, releasePickkoLock } = require('../../lib/state-bus');
const { publishToMainBot } = require('../../lib/mainbot-client');

function buildStageError(code, message) {
  const error = new Error(message);
  error.stageCode = code;
  return error;
}

function logStageFailure(code, message, extra = {}) {
  const payload = {
    code,
    message,
    ...extra,
  };
  log(`PICKKO_FAILURE_STAGE=${code} ${JSON.stringify(payload)}`);
}

// 인증 정보 (secrets.json에서 로드)
const SECRETS = loadSecrets();


const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
// ======================== 입력 파라미터 ========================
// 기본값(테스트용). 운영 연결 시 naver-monitor에서 argv로 주입.
const DEFAULTS = {
  date: '2026-07-05',
  start: '19:00',
  end: '20:00',
  room: 'A1',
  phone: '01035000586'
};

const ARGS = parseArgs(process.argv);
const CUSTOMER_NAME = (ARGS.name || '고객').replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';

// ✅ 입력 데이터 정규식 변환 (lib/validation.js 규칙 적용)
const rawInput = {
  phone: ARGS.phone || DEFAULTS.phone,
  date: ARGS.date || DEFAULTS.date,
  start: ARGS.start || DEFAULTS.start,
  end: ARGS.end || DEFAULTS.end,
  room: ARGS.room || DEFAULTS.room
};

const normalized = transformAndNormalizeData(rawInput);
if (!normalized) {
  logStageFailure('INPUT_NORMALIZE_FAILED', '입력 데이터 변환 실패', { rawInput });
  throw buildStageError('INPUT_NORMALIZE_FAILED', `입력 데이터 변환 실패: ${JSON.stringify(rawInput)}`);
}

const PHONE_NOHYPHEN = normalized.phone;
const DATE = normalized.date;
const START_TIME = normalized.start;
const END_TIME = normalized.end;
const ROOM = normalized.room;

const MODE = (process.env.MODE || 'dev').toLowerCase();
const ENABLE_NAME_SYNC = process.env.ENABLE_NAME_SYNC === '1';
const SKIP_NAME_SYNC =
  process.env.SKIP_NAME_SYNC === '1' ||
  process.env.MANUAL_RETRY === '1' ||
  !ENABLE_NAME_SYNC;
const SKIP_FINAL_PAYMENT = process.env.SKIP_FINAL_PAYMENT === '1';
// 테스트 전용: 결제금액을 0으로 변경하지 않고 실제 금액으로 결제
// SKIP_PRICE_ZERO=1 node src/pickko-accurate.js ...
const SKIP_PRICE_ZERO = process.env.SKIP_PRICE_ZERO === '1';
const MANUAL_PICKKO_LOCK_TTL_MS = 20 * 60 * 1000;

// ✅ DEV 모드 화이트리스트 (2026-02-23)
// 환경변수: DEV_WHITELIST_PHONES="01035000586,01054350586"
// 기본값: 이재룡(사장님), 김정민(부사장님)
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map(p => p.trim())
  .filter(p => /^\d{11}$/.test(p));

log(`📋 DEV 화이트리스트: [${DEV_WHITELIST.join(', ')}]`);
log(`🔧 MODE: ${MODE.toUpperCase()} ${MODE === 'dev' ? '(테스트 모드 - 화이트리스트만 허용)' : '(운영 모드 - 모든 번호 허용)'}`);
log(`📞 입력 번호: ${PHONE_NOHYPHEN}`);

// ================================================================================
// 🔐 절대 규칙: DEV / OPS 모드 엄격한 구분
// ================================================================================
// 
// DEV 모드: 화이트리스트 데이터로만 테스트 (고객 데이터 보호)
// OPS 모드: 테스트/검증 완료 후 사장님과 협의하여 전환 (실제 고객 예약 처리)
//
// 이것은 절대 규칙이다. 예외는 없다.
// ================================================================================

if (MODE === 'dev') {
  // 🔐 DEV 모드: 화이트리스트 검증 필수
  if (!DEV_WHITELIST.includes(PHONE_NOHYPHEN)) {
    const errorMsg = `
🛑 ========================================
   DEV 모드 화이트리스트 검증 실패!
========================================
   입력 번호: ${PHONE_NOHYPHEN}
   허용 번호: ${DEV_WHITELIST.join(', ')}
   
   ❌ 이 번호는 고객 데이터입니다!
   
   📋 개발 정책:
   • DEV 모드: 화이트리스트로만 테스트
   • OPS 모드: 모든 번호 허용 (테스트 완료 후 전환)
   
   테스트는 다음 번호로만 진행하세요:
   ✅ 이재룡 (010-3500-0586) - 사장님
   ✅ 김정민 (010-5435-0586) - 부사장님
   
   참고: MEMORY.md - DEV/OPS 모드 정책 참조
========================================
    `;
    log(errorMsg);
    throw new Error(`🔐 DEV 모드 화이트리스트 검증 실패: ${PHONE_NOHYPHEN}`);
  }
  
  log(`✅ 화이트리스트 검증 통과: ${PHONE_NOHYPHEN} (DEV 테스트 승인)`);
} else if (MODE === 'ops') {
  // 🚀 OPS 모드: 제약 없음 (테스트 완료 후 전환됨)
  log(`🚀 OPS 모드: 모든 번호 허용 (테스트 완료 후 전환됨)`);
  log(`⚠️  주의: OPS 모드 전환은 사장님과 스카의 협의로만 진행됩니다`);
}

// 룸명 → st_no (사장님 제공 HTML 기반)
const ROOM_ID = {
  A1: '206482',
  A2: '206450',
  B:  '206487'
};

function addMinutesHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = String(Math.floor((total % (24 * 60)) / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ✅ 시간 범위 변환은 lib/validation.js의 validateTimeRange 사용
// (중복 제거 및 라이브러리 일관성)

// ✅ 오류 발생 시 알림 (텔레그램/로그)
async function sendErrorNotification(errorMsg, context = {}) {
  log(`🚨 ERROR: ${errorMsg}`);
  log(`📋 컨텍스트: ${JSON.stringify(context)}`);
}

// ======================== 기존회원 이름 비교/알림 (4.5단계) ========================
async function notifyMemberNameMismatch(phoneRaw, pickkoName, naverName, mbNo = null) {
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

  log(`[4.5단계] ⚠️ 이름 불일치 감지 → 자동 수정 없이 알림만 발송`);
  await publishToMainBot({
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
  }).catch((error) => {
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

// ======================== 신규 회원 자동 등록 ========================
async function registerNewMember(page, phoneNoHyphen, customerName, reservationDate) {
  log('\n[3.5단계] 신규 회원 자동 등록');
  const phone1 = phoneNoHyphen.slice(0, 3);   // 010
  const phone2 = phoneNoHyphen.slice(3, 7);   // XXXX
  const phone3 = phoneNoHyphen.slice(7);       // XXXX
  const pin    = phoneNoHyphen.slice(3);       // 010 제외 8자리

  await page.goto('https://pickkoadmin.com/member/write.html', { waitUntil: 'domcontentloaded' });
  await delay(2000);

  // 1. 이름
  const nameInput = await page.$('input[name="mb_name"]');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(customerName, { delay: 50 });
  }
  await delay(300);

  // 2. 전화번호 (3분할)
  const ph1El = await page.$('#mb_phone1');
  const ph2El = await page.$('#mb_phone2');
  const ph3El = await page.$('#mb_phone3');
  if (ph1El) { await ph1El.click({ clickCount: 3 }); await ph1El.type(phone1, { delay: 50 }); }
  await delay(200);
  if (ph2El) { await ph2El.click({ clickCount: 3 }); await ph2El.type(phone2, { delay: 50 }); }
  await delay(200);
  if (ph3El) { await ph3El.click({ clickCount: 3 }); await ph3El.type(phone3, { delay: 50 }); }
  await delay(300);

  // 3. PIN (010 제외 8자리)
  const codeEl = await page.$('#mb_code');
  if (codeEl) {
    await codeEl.click({ clickCount: 3 });
    await codeEl.type(pin, { delay: 50 });
  }
  await delay(300);

  // 4. 생년월일 (예약날짜로 대체, datepicker API 사용)
  await page.evaluate((birthDate) => {
    const birthInput = document.querySelector('#mb_birth');
    if (!birthInput) return;
    birthInput.removeAttribute('readonly');
    if (typeof jQuery !== 'undefined' && jQuery(birthInput).data('datepicker')) {
      jQuery(birthInput).datepicker('setDate', new Date(birthDate));
    } else {
      birthInput.value = birthDate;
      birthInput.dispatchEvent(new Event('input', { bubbles: true }));
      birthInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, reservationDate);
  await delay(300);

  log(`✅ 회원정보 입력완료`);
  log(`   이름: ${maskName(customerName)}`);
  log(`   전화: ${maskPhone(phoneNoHyphen)}`);
  log(`   생년월일: ${reservationDate}`);

  // 5. form.submit() 직접 호출 (JS 생년월일 검증 우회)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
    page.evaluate(() => {
      const form = document.querySelector('form#memberFrom, form');
      if (form) HTMLFormElement.prototype.submit.call(form);
    })
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

async function main() {
  let browser;
  let lockAcquired = false;
  let currentStage = 'INIT';
  const setStage = (stage) => {
    currentStage = stage;
    log(`📍 단계 진입: ${stage}`);
  };
  // try/catch 양쪽에서 접근 가능하도록 바깥에 선언
  const releaseLock = async () => {
    if (lockAcquired) {
      try { await releasePickkoLock('manual'); log('🔓 픽코 락 해제'); } catch {}
      lockAcquired = false;
    }
  };

  try {
    log(`🚀 픽코 예약 등록 시작`);

    // 픽코 단독접근 락 획득
    // 수동 작업은 실제 운영자가 기다리는 write-path이므로 TTL을 더 길게 잡아 자동 모니터가 중간에 끼어들지 않게 한다.
    setStage('LOCK_ACQUIRE');
    lockAcquired = await acquirePickkoLock('manual', MANUAL_PICKKO_LOCK_TTL_MS);
    if (!lockAcquired) {
      logStageFailure('LOCK_CONFLICT', '픽코 락 획득 실패', { mode: MODE });
      log('⚠️ 픽코 락 획득 실패 — 자동 에이전트가 픽코 사용 중. 잠시 후 재시도하세요.');
      process.exit(1);
    }
    log(`🔒 픽코 락 획득 (manual, ttl=${Math.floor(MANUAL_PICKKO_LOCK_TTL_MS / 60000)}m)`);
    
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    page.setDefaultTimeout(30000);

    await delay(500);

    // ✅ 등록 완료/오류 alert 팝업 자동 "확인"
    setupDialogHandler(page, log);
    
    // ======================== 1단계: 로그인 ========================
    setStage('LOGIN');
    log('\n[1단계] 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료');

    // ✅ 시간 범위 변환 확인 (로그인 후)
    const timeRangeCheck = validateTimeRange(START_TIME, END_TIME);
    if (!timeRangeCheck.ok) {
      throw new Error(`시간 변환 실패: ${timeRangeCheck.error}`);
    }
    log(`✅ 시간 변환 완료: ${START_TIME} ~ ${END_TIME}${timeRangeCheck.isCrossMidnight ? ' (자정 넘어감)' : ''}`);
    
    // ======================== 2단계: 페이지 이동 ========================
    setStage('OPEN_STUDY_WRITE');
    log('\n[2단계] 예약 등록 페이지');
    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    
    // ======================== 3단계: 회원 검색 ========================
    setStage('MEMBER_SEARCH');
    log('\n[3단계] 회원 검색');
    await page.evaluate((phone) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      let targetInput = null;
      for (const input of inputs) {
        if (input.placeholder && (input.placeholder.includes('이름') || input.placeholder.includes('검색'))) {
          targetInput = input;
          break;
        }
      }
      if (!targetInput && inputs.length > 0) targetInput = inputs[inputs.length - 1];
      
      if (targetInput) {
        targetInput.value = phone;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    }, PHONE_NOHYPHEN);
    
    log(`✅ 전화번호(${PHONE_NOHYPHEN}) 입력 완료`);
    await delay(3000);
    
    // ======================== 4단계: 회원 선택 ✅ (검증 추가됨) ========================
    setStage('MEMBER_SELECT');
    log('\n[4단계] 회원 선택');
    
    // 🔧 회원정보 검증 함수
    const formatPhoneForComparison = (phone) => {
      // 01035000586 → 010-3500-0586
      if (!phone || phone.length !== 11) return phone;
      return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
    };
    
    const verifyMemberInfo = async (retryCount = 0) => {
      if (retryCount >= 5) {
        const errorMsg = `❌ 회원정보 검증 실패: 5회 시도 후에도 정보 불일치`;
        log(errorMsg);
        // 알람 전송 (추후 텔레그램 연동)
        await sendErrorNotification(errorMsg, { 
          step: '4단계', 
          phone: PHONE_NOHYPHEN, 
          retries: retryCount 
        });
        throw buildStageError('MEMBER_SELECT_FAILED', errorMsg);
      }
      
      // 회원 선택 버튼 클릭 (page.click → evaluate: Runtime.callFunctionOn 타임아웃 방지)
      await page.evaluate(() => {
        const btn = document.querySelector('a#mb_select_btn');
        if (btn) { btn.click(); return; }
        // 폴백: btn_box 중 "회원 선택" 텍스트
        const links = document.querySelectorAll('a.btn_box');
        for (const a of links) if (a.textContent.includes('회원 선택')) { a.click(); return; }
      });
      await delay(2000);

      // ★ 신규 고객 감지: 첫 시도에서 a.mb_select 없으면 자동 회원 등록
      const hasMember = await page.evaluate(() => !!document.querySelector('a.mb_select'));
      if (!hasMember && retryCount >= 1) {
        // 등록 후 재시도에서도 회원이 없으면 → 등록은 됐지만 검색 안 됨
        const failMsg = `❌ 신규 등록 후에도 회원 검색 안됨 (${PHONE_NOHYPHEN}) → 픽코 수동 확인 필요`;
        log(failMsg);
        throw buildStageError('MEMBER_REGISTER_OR_SEARCH_FAILED', failMsg);
      }

      if (!hasMember && retryCount === 0) {
        log(`⚠️ 픽코 미등록 고객(${PHONE_NOHYPHEN}) → 신규 회원 자동 등록 시작`);
        await page.keyboard.press('Escape');
        await delay(500);

        // ★ 등록 실패 시 즉시 throw (내부에서 처리)
        await registerNewMember(page, PHONE_NOHYPHEN, CUSTOMER_NAME, DATE);

        // Stage [3] 재실행: 신규 등록된 회원 검색
        log('\n[3단계 재실행] 신규 등록 후 재검색');
        await page.evaluate((phone) => {
          const inputs = document.querySelectorAll('input[type="text"]');
          let targetInput = null;
          for (const input of inputs) {
            if (input.placeholder && (input.placeholder.includes('이름') || input.placeholder.includes('검색'))) {
              targetInput = input;
              break;
            }
          }
          if (!targetInput && inputs.length > 0) targetInput = inputs[inputs.length - 1];
          if (targetInput) {
            targetInput.value = phone;
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
          }
        }, PHONE_NOHYPHEN);
        await delay(3000);

        await verifyMemberInfo(1); // retryCount=1로 재시도 (재등록 방지)
        return;
      }

      // 모달 내 "선택" 버튼 클릭
      const memberSelectResult = await page.evaluate(() => {
        const selectBtn = document.querySelector('a.mb_select');
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
      
      // 회원정보 검증
      const memberInfo = await page.evaluate(() => {
        const mbInfo = document.querySelector('span#mb_info');
        if (!mbInfo) return null;
        
        const text = mbInfo.textContent.trim();
        // 형식: "노예진(010-5101-5409)"
        const match = text.match(/(.+?)\((.+?)\)/);
        if (!match) return null;
        
        return {
          name: match[1].trim(),
          phone: match[2].trim().replace(/-/g, '')  // 하이푼 제거
        };
      });
      
      if (!memberInfo) {
        log(`⚠️ 회원정보 추출 실패 (시도 ${retryCount + 1}/5)`);
        return await verifyMemberInfo(retryCount + 1);
      }
      
      log(`📋 선택된 회원: ${maskName(memberInfo.name)}(${maskPhone(memberInfo.phone)})`);
      
      // 전화번호 비교 (하이푼 제거 후)
      const inputPhoneNoHyphen = PHONE_NOHYPHEN;
      const selectedPhoneNoHyphen = memberInfo.phone;
      
      if (inputPhoneNoHyphen !== selectedPhoneNoHyphen) {
        log(`❌ 전화번호 불일치`);
        log(`   입력: ${formatPhoneForComparison(inputPhoneNoHyphen)}`);
        log(`   선택: ${formatPhoneForComparison(selectedPhoneNoHyphen)}`);
        log(`⏳ 회원 선택 다시 수행... (시도 ${retryCount + 1}/5)`);
        
        return await verifyMemberInfo(retryCount + 1);
      }
      
      log(`✅ 회원정보 검증 완료 (시도 ${retryCount + 1}/5)`);
      log(`   이름: ${maskName(memberInfo.name)}`);
      log(`   전화: ${maskPhone(memberInfo.phone)}`);
      return memberInfo;
    };
    
    // 회원 선택 및 검증 실행
    const selectedMemberInfo = await verifyMemberInfo();

    // ======================== 4.5단계: 기존회원 이름 비교 ========================
    log('\n[4.5단계] 기존회원 이름 비교');
    try {
      if (SKIP_NAME_SYNC) {
        log(`[4.5단계] 이름 비교 알림 생략 (ENABLE_NAME_SYNC=${ENABLE_NAME_SYNC ? '1' : '0'})`);
      } else if (!selectedMemberInfo) {
        log('[4.5단계] 선택된 기존회원 정보 없음 → 비교 생략');
      } else {
        const nameCheckResult = await notifyMemberNameMismatch(
          PHONE_NOHYPHEN,
          selectedMemberInfo.name,
          CUSTOMER_NAME,
          null
        );
        if (nameCheckResult.skipped) {
          log(`[4.5단계] 스킵 (${nameCheckResult.reason})`);
        } else if (nameCheckResult.mismatchNotified) {
          log('[4.5단계] 이름 불일치 알림 발송 완료');
        } else {
          log('[4.5단계] 이름 일치 → 변경 불필요');
        }
      }
    } catch (e) {
      log(`⚠️ [4.5단계] 이름 비교 오류 (예약 계속 진행): ${e.message}`);
    }
    
    // ======================== 5단계: 날짜 확인 ✅ (검증 추가됨) ========================
    setStage('DATE_SELECT');
    log('\n[5단계] 날짜 확인');
    
    // 날짜 포맷 정규화 함수
    const normalizeDate = (dateStr) => {
      if (!dateStr) return '';
      const match = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) {
        const [, y, m, d] = match;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      return dateStr;
    };
    
    // 날짜 설정 및 검증 함수
    const setAndVerifyDate = async (retryCount = 0) => {
      if (retryCount >= 5) {
        const errorMsg = `❌ 날짜 검증 실패: 5회 시도 후에도 날짜 불일치`;
        log(errorMsg);
        await sendErrorNotification(errorMsg, {
          step: '5단계',
          targetDate: DATE,
          retries: retryCount
        });
        throw buildStageError('DATE_SELECT_FAILED', errorMsg);
      }
      
      // 1) 예약일자 읽기
      const prevScheduleDate = await page.evaluate(() => {
        const li = document.querySelector('li#prev_schedule');
        let text = li ? li.textContent.trim() : '';
        text = text.replace(/\s+/g, '').split('T')[0];
        return text;
      });
      
      // 2) 입력필드 현재값 읽기
      let inputDate = await page.evaluate(() => {
        const inp = document.querySelector('input#start_date');
        let val = inp ? inp.value : '';
        val = val.replace(/\s+/g, '').split('T')[0];
        return val;
      });
      
      const prevScheduleDateNorm = normalizeDate(prevScheduleDate);
      const inputDateNorm = normalizeDate(inputDate);
      const targetDateNorm = normalizeDate(DATE);
      
      log(`📅 [${retryCount + 1}/5] 예약일자: ${prevScheduleDateNorm}`);
      log(`📅 [${retryCount + 1}/5] 입력필드: ${inputDateNorm}`);
      log(`📅 [${retryCount + 1}/5] 목표 날짜: ${targetDateNorm}`);
      
      // 3) 입력필드가 예약일자와 같으면 스킵
      if (inputDateNorm === prevScheduleDateNorm) {
        log(`✅ 입력필드와 예약일자 일치. 날짜 설정 스킵!`);
        return;
      } else {
        log(`⚠️ 날짜가 다릅니다. 변환 진행...`);

        // 🔧 하이브리드 방식: 코드로 값 변경 + 달력 클릭으로 내부 상태 동기화
        
        // [1단계] 코드로 날짜 값 직접 설정
        log(`📅 [1단계] 날짜 값 직접 세팅: ${DATE}`);
        
        const setDateOk = await page.evaluate((dateStr) => {
          const inp = document.querySelector('input#start_date');
          if (!inp) return { ok: false, reason: 'no #start_date' };

          // 1) 값 직접 설정
          inp.focus();
          inp.value = dateStr;

          // 2) 이벤트 트리거
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));

          // 3) jQuery UI datepicker가 있으면 setDate까지 반영
          try {
            if (window.jQuery && window.jQuery.fn && window.jQuery.fn.datepicker) {
              window.jQuery(inp).datepicker('setDate', dateStr);
              window.jQuery(inp).trigger('change');
            }
          } catch (e) {
            // 무시
          }

          return { ok: true, value: inp.value };
        }, DATE);

        log(`📅 [1단계] 결과: ${JSON.stringify(setDateOk)}`);

        // [2단계] 달력 팝업 열기 (page.click → protocolTimeout 행 방지 위해 evaluate로 대체)
        log(`📅 [2단계] 달력 팝업 열기`);
        await page.evaluate(() => {
          const inp = document.querySelector('input#start_date');
          if (!inp) return;
          // jQuery datepicker API로 직접 팝업 열기 (page.click의 CDP 블로킹 회피)
          if (window.jQuery && window.jQuery.fn && window.jQuery.fn.datepicker) {
            window.jQuery(inp).datepicker('show');
          } else {
            inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        });
        await delay(800);  // 팝업 로드 대기

        const [ty, tm, td] = DATE.split('-').map(n => parseInt(n, 10));

        // [3단계] 달력에서 정확한 셀렉터로 날짜 클릭
        log(`📅 [3단계] 달력에서 ${ty}년 ${tm}월 ${td}일 클릭`);
        const clicked = await page.evaluate((year, month1, day) => {
          const m0 = month1 - 1;  // 0-indexed month
          const dayStr = String(day);
          
          // 정확한 셀렉터: td[data-handler="selectDay"][data-year="${year}"][data-month="${m0}"] a
          const cells = document.querySelectorAll(`td[data-handler="selectDay"][data-year="${year}"][data-month="${m0}"] a`);
          for (const a of cells) {
            if (a.textContent.trim() === dayStr) {
              console.log(`✅ 셀렉터 매칭 성공: data-year=${year}, data-month=${m0}, text=${dayStr}`);
              a.click();
              return true;
            }
          }
          
          console.log(`⚠️ 정확한 셀렉터 실패. 폴백: 모든 링크에서 검색`);
          // 폴백: 모든 a 태그에서 숫자만 맞는 것 찾기
          const allLinks = document.querySelectorAll('.datepicker a, .ui-datepicker a');
          for (const a of allLinks) {
            if (a.textContent.trim() === dayStr && !a.classList.contains('disabled') && !a.classList.contains('ui-state-disabled')) {
              console.log(`✅ 폴백 셀렉터 매칭: text=${dayStr}`);
              a.click();
              return true;
            }
          }
          
          return false;
        }, ty, tm, td);

        log(`📅 [3단계] 달력 클릭 결과: ${clicked ? '✅ 성공' : '❌ 실패'}`);

        await delay(1000);  // 팝업 닫기 대기

        // 최종 검증
        const after = await page.evaluate(() => document.querySelector('input#start_date')?.value || '');
        if (after !== DATE) {
          log(`⚠️ 최종 검증 실패: start_date=${after} (expected ${DATE})`);
          // 재시도
          await setAndVerifyDate(retryCount + 1);
        } else {
          log(`✅ 최종 검증 성공: ${after}`);
        }
      }
    };
    
    // 날짜 설정 및 검증 실행
    await setAndVerifyDate();
    
    // ======================== 30분 단위 슬롯 변환 (픽코 고유 기능) ========================
    // 픽코는 시간을 30분 단위 슬롯으로 관리함
    // 예: "00:00~01:00" → ["00:00", "00:30", "01:00"] (3개 슬롯)
    function timeToSlots(startTime, endTime) {
      const [startHour, startMin] = startTime.split(':').map(Number);
      const [endHour, endMin] = endTime.split(':').map(Number);

      const startMinutes = startHour * 60 + startMin;
      let endMinutes = endHour * 60 + endMin;

      // 자정 넘어가는 경우 처리 (예: 23:00~02:00 → endMinutes += 1440)
      if (endMinutes <= startMinutes) {
        endMinutes += 24 * 60;
      }

      const slots = [];
      for (let min = startMinutes; min <= endMinutes - 1; min += 30) {
        const h = Math.floor(min / 60) % 24; // 24시간 나머지 (자정 넘어도 00~23 유지)
        const m = min % 60;
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
      return slots;
    }
    
    const TIME_SLOTS = timeToSlots(START_TIME, END_TIME);
    log(`🔄 [30분 단위 슬롯 변환] ${START_TIME}~${END_TIME} → [${TIME_SLOTS.join(', ')}] (${TIME_SLOTS.length}개)`);

    // ─────────────────────────────────────────────────────────────
    // [6-0] 오늘 예약: 현재 시각 기준 경과 슬롯 자동 조정
    //   예) 10:59에 감지된 11:00~13:00 예약 → 픽코 진입 시 이미 11:00 슬롯 사라짐
    //       → 11:30부터 선택 (종료 슬롯은 유지)
    // ─────────────────────────────────────────────────────────────
    const _nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const _todayStr = `${_nowKST.getFullYear()}-${String(_nowKST.getMonth()+1).padStart(2,'0')}-${String(_nowKST.getDate()).padStart(2,'0')}`;

    let effectiveTimeSlots = TIME_SLOTS;

    if (DATE === _todayStr && TIME_SLOTS.length >= 2) {
      const _nowMin = _nowKST.getHours() * 60 + _nowKST.getMinutes();
      // 현재 분을 다음 30분 경계로 올림 (11:01 → 11:30, 11:00 → 11:00)
      const _nextSlotMin = Math.ceil(_nowMin / 30) * 30;

      const [_fh, _fm] = TIME_SLOTS[0].split(':').map(Number);
      const _firstSlotMin = _fh * 60 + _fm;

      if (_nextSlotMin > _firstSlotMin) {
        effectiveTimeSlots = TIME_SLOTS.filter(slot => {
          const [h, m] = slot.split(':').map(Number);
          return h * 60 + m >= _nextSlotMin;
        });

        const _nowHH = String(Math.floor(_nowMin / 60)).padStart(2, '0');
        const _nowMM = String(_nowMin % 60).padStart(2, '0');
        const _skipped = TIME_SLOTS.length - effectiveTimeSlots.length;
        log(`⏰ [6-0] 경과 슬롯 ${_skipped}개 스킵 (현재 ${_nowHH}:${_nowMM}): ${TIME_SLOTS[0]}~${TIME_SLOTS[TIME_SLOTS.length-1]} → 유효: [${effectiveTimeSlots.join(', ')}]`);

        if (effectiveTimeSlots.length < 2) {
          const _err = new Error(`${START_TIME}~${END_TIME} (현재 ${_nowHH}:${_nowMM}) — 남은 유효 슬롯 없음`);
          _err.code = 'TIME_ELAPSED';
          throw _err;
        }
      }
    }

    // ======================== 6단계: 룸 & 시간 선택 ========================
    setStage('ROOM_AND_SLOT_SELECT');
    log('\n[6단계] 룸 & 시간 선택');
    
    // ─────────────────────────────────────────────────────────────
    // [6-1] 룸 탭 클릭
    // ─────────────────────────────────────────────────────────────
    log(`[6-1] ${ROOM} 룸 탭 클릭`);
    await page.evaluate((room) => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
            if (el.children.length === 0 && el.textContent.includes(room) && el.textContent.includes('스터디')) {
                el.click();
                return;
            }
        }
    }, ROOM);
    log(`✅ ${ROOM} 룸 탭 클릭 완료`);
    await delay(1500);
    
    const stNo = ROOM_ID[ROOM];
    if (!stNo) throw buildStageError('ROOM_MAPPING_FAILED', `ROOM_ID 매핑 없음: ROOM=${ROOM}`);

    // ─────────────────────────────────────────────────────────────
    // [6-2] 스케줄 갱신 대기
    // ─────────────────────────────────────────────────────────────
    log(`[6-2] 스케줄 갱신 대기중... (date=${DATE}, st_no=${stNo})`);
    let scheduleReady = false;
    for (let i = 0; i < 20; i++) {
      scheduleReady = await page.evaluate((dateStr, stNoStr) => {
        return !!document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
      }, DATE, stNo);
      if (scheduleReady) break;
      await delay(250);
    }
    log(scheduleReady ? '✅ 스케줄 갱신 감지' : '⚠️ 스케줄 갱신 감지 실패');

    // ─────────────────────────────────────────────────────────────
    // [6-3] 시간표 영역으로 스크롤
    // ─────────────────────────────────────────────────────────────
    log(`[6-3] 시간표 영역으로 스크롤`);
    try {
      const scrolled = await page.evaluate((dateStr, stNoStr) => {
        const el = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      }, DATE, stNo);
      log(scrolled ? '✅ 스크롤 완료' : '⚠️ 스크롤 대상을 못 찾음');
    } catch (e) {
      log(`⚠️ 스크롤 실패: ${e.message}`);
    }
    await delay(500);

    // ─────────────────────────────────────────────────────────────
    // [6-4] 시간 선택 로직 (30분 단위 슬롯 순차 선택)
    // ─────────────────────────────────────────────────────────────
    log(`[6-4] 시간 선택: ${effectiveTimeSlots.length}개 슬롯 순차 선택 (전체 ${TIME_SLOTS.length}개 중)`);
    
    let chosen = null;
    let attemptCount = 0;

    // 🔄 30분 단위 슬롯 선택: 첫 슬롯 ~ 마지막 슬롯
    // 예: ["00:00", "00:30", "01:00"] → "00:00"과 "01:00" 선택 (픽코가 중간 자동 채움)
    // [6-0]에서 경과 슬롯이 제거된 effectiveTimeSlots 사용
    const firstSlot = effectiveTimeSlots[0];
    const lastSlot = effectiveTimeSlots[effectiveTimeSlots.length - 1];

    // 🔧 Duration 계산 (유효 슬롯 개수 기반)
    const durationMin = (effectiveTimeSlots.length - 1) * 30;  // 슬롯 개수 - 1 × 30분

    log(`   ⏰ 첫 슬롯: ${firstSlot} / 마지막 슬롯: ${lastSlot} / 기간: ${durationMin}분`);
    
    // 시간 선택 시도 (AJAX 갱신 타이밍을 고려해 최대 3회 재시도)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        log(`   ⏰ 재시도 #${attempt + 1}: 스케줄 갱신 대기 후 재시도...`);
        await delay(1500);
      }
      attemptCount++;
      log(`   ⏰ 시도 #${attemptCount}: ${firstSlot} -> ${lastSlot}`);
      
      const s = firstSlot;
      const e = lastSlot;
      log(`      범위: ${s} ~ ${e}`);

      // 🎯 **4-Tier Fallback Selector** - 정확한 시간대 선택
      const res = await page.evaluate((dateStr, stNoStr, start, end, durationMin, custName, phoneLast4) => {
        const debug = {
          methodUsed: null,
          startExists: false,
          endExists: false,
          startUsed: false,
          endUsed: false,
          startClicked: false,
          endClicked: false,
          okMid: true,
          alreadyRegistered: false,
          alreadyRegisteredBy: null,
          errors: []
        };

        let startLi = null;
        let endLi = null;

        // 🔍 Method 1: li[date][st_no][start][mb_no=""]
        startLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${start}"][mb_no=""]`);
        endLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${end}"][mb_no=""]`);
        if (startLi && endLi) {
          debug.methodUsed = 'Method-1: li[date][st_no][start][mb_no=""]';
        }

        // 🔍 Method 2: li[date][st_no][start] (mb_no 제약 해제)
        if (!startLi || !endLi) {
          startLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${start}"]`);
          endLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${end}"]`);
          if (startLi && endLi) {
            debug.methodUsed = 'Method-2: li[date][st_no][start]';
          }
        }

        // 🔍 Method 3: li[st_no][start] (date 제약 해제)
        if (!startLi || !endLi) {
          startLi = document.querySelector(`li[st_no="${stNoStr}"][start="${start}"]`);
          endLi = document.querySelector(`li[st_no="${stNoStr}"][start="${end}"]`);
          if (startLi && endLi) {
            debug.methodUsed = 'Method-3: li[st_no][start]';
          }
        }

        // 🔍 Method 4: 모든 li 순회 및 속성 매칭
        if (!startLi || !endLi) {
          const allLis = document.querySelectorAll('li[start]');
          for (const li of allLis) {
            const liStart = li.getAttribute('start');
            const liStNo = li.getAttribute('st_no');
            if (liStart === start && liStNo === stNoStr && !startLi) startLi = li;
            if (liStart === end && liStNo === stNoStr && !endLi) endLi = li;
          }
          if (startLi && endLi) {
            debug.methodUsed = 'Method-4: li[start] attribute loop';
          }
        }

        // ✅ 요소 존재 여부 확인
        debug.startExists = !!startLi;
        debug.endExists = !!endLi;

        // ✅ 요소의 'used' 클래스 확인
        if (startLi) debug.startUsed = startLi.classList.contains('used');
        if (endLi) debug.endUsed = endLi.classList.contains('used');

        // 🔍 슬롯이 사용중이면 동일 고객 여부 확인 (이름 또는 전화 뒤 4자리)
        if (debug.startUsed && startLi) {
          const slotText = (startLi.textContent || '').replace(/\s+/g, ' ').trim();
          const mbNo   = startLi.getAttribute('mb_no')   || '';
          const mbName = startLi.getAttribute('mb_name') || '';
          const combined = [slotText, mbNo, mbName].join(' ');

          const nameMatch  = custName   && custName.length >= 2 && combined.includes(custName);
          const phoneMatch = phoneLast4 && (combined.includes(phoneLast4) || mbNo.endsWith(phoneLast4));

          if (nameMatch || phoneMatch) {
            debug.alreadyRegistered  = true;
            debug.alreadyRegisteredBy = (slotText || mbName || mbNo).slice(0, 40);
          }
        }

        // ✅ 클릭 가능 조건 확인
        if (startLi && !debug.startUsed) debug.startClicked = true;
        if (endLi && !debug.endUsed) debug.endClicked = true;

        // ✅ 중간 시간대 전부 확인
        if (durationMin > 30 && debug.startClicked && debug.endClicked) {
          const startMin = (() => {
            const [h, m] = start.split(':').map(Number);
            return h * 60 + m;
          })();
          for (let t = startMin; t < startMin + durationMin; t += 30) {
            const hh = String(Math.floor(t / 60)).padStart(2, '0');
            const mm = String(t % 60).padStart(2, '0');
            const midLi = document.querySelector(`li[st_no="${stNoStr}"][start="${hh}:${mm}"]`);
            if (!(midLi && !midLi.classList.contains('used'))) {
              debug.okMid = false;
              debug.errors.push(`Mid-slot blocked: ${hh}:${mm}`);
              break;
            }
          }
        }

        // 🎯 실제 클릭 수행
        if (debug.startClicked && debug.endClicked && debug.okMid) {
          startLi.click();
          endLi.click();
        }

        return debug;
      }, DATE, stNo, s, e, durationMin, CUSTOMER_NAME, PHONE_NOHYPHEN.slice(-4));

      // 로그 출력
      if (res.methodUsed) {
        log(`       ✅ ${res.methodUsed}`);
      }
      log(`       ├─ start: exists=${res.startExists} used=${res.startUsed} clickable=${res.startClicked}`);
      log(`       ├─ end: exists=${res.endExists} used=${res.endUsed} clickable=${res.endClicked}`);
      log(`       └─ mid: ok=${res.okMid} ${res.errors.length > 0 ? `(${res.errors.join(', ')})` : ''}`);

      // 🔍 슬롯 사용중이지만 동일 고객 → 이미 등록된 것으로 완료 처리
      if (res.alreadyRegistered) {
        log(`       ✅ 동일 고객 슬롯 이미 등록됨: "${res.alreadyRegisteredBy}" → 완료 처리`);
        const _alreadyErr = new Error(`슬롯 이미 등록됨: ${res.alreadyRegisteredBy}`);
        _alreadyErr.code = 'ALREADY_REGISTERED';
        throw _alreadyErr;
      }

      // ✅ 선택 성공 조건
      if (res.startClicked && res.endClicked && res.okMid) {
        chosen = { 
          start: s, 
          end: e,
          method: res.methodUsed
        };
        log(`       🎯 **시간 선택 성공!**`);
        break;
      }

      await delay(350);
    }

    // ─────────────────────────────────────────────────────────────
    // [6-5] 검증 - 선택 여부 확인
    // ─────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────
    // [6-5] 검증 - 선택 여부 확인 (OPS vs DEV 분리)
    // ─────────────────────────────────────────────────────────────
    if (!chosen) {
      if (MODE === 'ops') {
        // 🔴 OPS 모드: 실패 + 즉시 알람 + 중단
        const errorAlert = {
          title: '⚠️ [OPS-실패] 예약 시간 선택 불가',
          phone: PHONE_NOHYPHEN,
          date: DATE,
          requestTime: `${START_TIME}~${END_TIME}`,
          room: ROOM,
          reason: `해당 시간대 모두 예약됨 (최대 ${TIME_SLOTS.length}개 슬롯 확인)`,
          action: 'DEV 모드로 전환 및 분석 필요',
          timestamp: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
        };
        
        log(`\n🚨 [OPS-CRITICAL] 시간 선택 실패`);
        log(`📋 알람 내용:`);
        log(`   • 고객 번호: ${maskPhone(errorAlert.phone)}`);
        log(`   • 예약 날짜: ${errorAlert.date}`);
        log(`   • 요청 시간: ${errorAlert.requestTime}`);
        log(`   • 요청 룸: ${errorAlert.room}`);
        log(`   • 실패 사유: ${errorAlert.reason}`);
        log(`   • 조치: ${errorAlert.action}`);
        
        // 추후 텔레그램 알람 연동
        // await sendAlert(errorAlert);
        
        throw buildStageError('TIME_SLOT_SELECT_FAILED', `[OPS-CRITICAL] 시간 선택 실패 - 예약 불가능한 시간대`);
      } else {
        // 🟡 DEV 모드: 로그만 출력 후 중단
        log(`⚠️ [DEV] 시간 선택 실패: 모든 슬롯이 예약됨`);
        throw buildStageError('TIME_SLOT_SELECT_FAILED', `[DEV] 시간 선택 실패`);
      }
    }

    log(`[6-5] ✅ 시간 선택 완료: ${chosen.start}~${chosen.end} (방법: ${chosen.method || 'unknown'})`);

    // ─────────────────────────────────────────────────────────────
    // [6-6] 검증 - Input 필드 확인
    // ─────────────────────────────────────────────────────────────
    log(`[6-6] 선택 검증 (input 필드 확인)`);
    
    await delay(1000);  // 화면 렌더링 대기
    
    const timeVerification = await page.evaluate(() => {
      const inps = {
        start_date: document.querySelector('input#start_date')?.value || '',
        start_time: document.querySelector('input#start_time')?.value || '',
        end_date: document.querySelector('input#end_date')?.value || '',
        end_time: document.querySelector('input#end_time')?.value || ''
      };

      return {
        hasStartDate: !!inps.start_date,
        hasStartTime: !!inps.start_time,
        hasEndDate: !!inps.end_date,
        hasEndTime: !!inps.end_time,
        values: inps
      };
    });

    log(`       ├─ start_date: ${timeVerification.values.start_date || '(empty)'} ${timeVerification.hasStartDate ? '✅' : '❌'}`);
    log(`       ├─ start_time: ${timeVerification.values.start_time || '(empty)'} ${timeVerification.hasStartTime ? '✅' : '❌'}`);
    log(`       ├─ end_date: ${timeVerification.values.end_date || '(empty)'} ${timeVerification.hasEndDate ? '✅' : '❌'}`);
    log(`       └─ end_time: ${timeVerification.values.end_time || '(empty)'} ${timeVerification.hasEndTime ? '✅' : '❌'}`);

    // ⚠️ 검증 경고
    if (!timeVerification.hasStartTime || !timeVerification.hasEndTime) {
      log(`⚠️ 경고: 시간이 input 필드에 반영되지 않았을 수 있습니다. 계속 진행합니다.`);
    }

    await delay(1500);
    // ======================== 7단계: 저장 ========================
    setStage('SAVE_PRECHECK');
    log('\n[7단계] 저장');

    const sanity = await page.evaluate(() => {
      const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

      const startDate = clean(document.querySelector('#start_date')?.value);
      const startTime = clean(document.querySelector('#start_time')?.value);
      const endDate = clean(document.querySelector('#end_date')?.value);
      const endTime = clean(document.querySelector('#end_time')?.value);

      // 🔧 개선: 표(tr) 기반 추출 (스크립트 텍스트 끼어들기 방지)
      let priceText = null;
      let useTimeText = null;

      // 표에서 "이용시간"과 "이용금액" 행 찾기
      const rows = document.querySelectorAll('tr');
      for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        
        if (!th || !td) continue;
        
        const thText = clean(th.textContent);
        const tdText = clean(td.textContent);
        
        if (thText.includes('이용시간')) {
          useTimeText = tdText;
        }
        if (thText.includes('이용금액')) {
          priceText = tdText;
        }
      }

      // 폴백: 표 추출이 실패하면 원래 방식도 시도
      if (!priceText) {
        const fallback = clean(document.querySelector('#study_price')?.innerText || document.querySelector('#study_price')?.textContent);
        if (fallback) priceText = fallback;
      }

      const parseMoney = (s) => {
        if (!s) return null;
        const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : null;
      };

      const priceNum = parseMoney(priceText);

      // 안전장치: 값에 "-"가 포함되거나 음수면 즉시 중단
      const badAmount = (typeof priceText === 'string' && priceText.includes('-')) || (priceNum !== null && priceNum < 0);

      const missingTime = !startTime || !endTime;

      const toTs = (d, t) => {
        if (!d || !t) return null;
        const ms = Date.parse(`${d}T${t}:00`);
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
        startDate, startTime, endDate, endTime,
        durationMin,
        priceText, priceNum,
        useTimeText,
        badTime, badAmount,
        extracted: { hasPrice: !!priceText, hasUseTime: !!useTimeText }
      };
    });

    log(`🧪 저장 전 확인: ${JSON.stringify(sanity)}`);

    // 안전장치: badTime 또는 badAmount가 true면 즉시 중단
    if (sanity.badTime) {
      throw buildStageError('SAVE_TIME_VALIDATION_FAILED',
        `저장 중단: 시간 비정상 (start=${sanity.startDate} ${sanity.startTime}, end=${sanity.endDate || sanity.startDate} ${sanity.endTime}, durationMin=${sanity.durationMin})`
      );
    }

    if (sanity.badAmount) {
      throw buildStageError('SAVE_AMOUNT_VALIDATION_FAILED',
        `저장 중단: 금액 비정상 (가격=${sanity.priceText}, 파싱결과=${sanity.priceNum})`
      );
    }

    // 경고: 추출 실패해도 진행 (마크업 변경 대비)
    if (!sanity.extracted?.hasPrice) {
      log('⚠️ 저장 전 확인: 이용금액을 찾지 못했습니다. (안전장치: 음수/시간 확인만 통과하면 계속)');
    }
    if (!sanity.extracted?.hasUseTime) {
      log('⚠️ 저장 전 확인: 이용시간을 찾지 못했습니다. (안전장치: 음수/시간 확인만 통과하면 계속)');
    }

    log('💾 "작성하기" 버튼 클릭...');
    // page.click() 대신 evaluate()로 직접 클릭
    // 이유: page.click()은 내부적으로 Runtime.callFunctionOn을 여러 번 호출 →
    //       픽코 서버 응답 지연 시 protocolTimeout(180초) 발생
    // evaluate()는 단일 Runtime.evaluate 호출로 즉시 반환
    const submitClicked = await page.evaluate(() => {
        const btn = document.querySelector('input[type="submit"][value="작성하기"]');
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

    await delay(1500);

    // ======================== 7-5단계: 최종 검증 (결제 직전) ========================
    log('\n[7-5단계] 최종 검증 (결제 직전)');
    
    const finalVerification = await page.evaluate(() => {
      const verification = {
        mbInfo: null,           // 회원명(번호)
        roomName: null,         // 룸 이름
        useTime: null,          // 이용시간
        priceField: null,       // 결제금액
        errors: [],
        warnings: []
      };

      // 🔍 <tbody>의 테이블에서 데이터 추출
      const rows = document.querySelectorAll('tbody tr');
      for (const row of rows) {
        const th = row.querySelector('th');
        const tds = row.querySelectorAll('td');
        
        if (!th || !tds.length) continue;
        
        const thText = (th.textContent || '').trim();
        
        // 1️⃣ 회원 정보: <span id="mb_info">이지숙(010-3741-0771)</span>
        if (thText.includes('회원 정보')) {
          const mbSpan = row.querySelector('span#mb_info');
          if (mbSpan) {
            verification.mbInfo = (mbSpan.textContent || '').trim();
          }
        }
        
        // 2️⃣ 스터디룸: 첫 번째 td
        if (thText.includes('스터디룸')) {
          if (tds[0]) {
            verification.roomName = (tds[0].textContent || '').trim();
          }
        }
        
        // 3️⃣ 이용시간: colspan이 있는 td
        if (thText.includes('이용시간')) {
          for (const td of tds) {
            const tdText = (td.textContent || '').trim();
            if (tdText.includes('년') || tdText.includes('월') || tdText.includes('일')) {
              verification.useTime = tdText;
              break;
            }
          }
        }
        
        // 4️⃣ 결제하기 버튼: price 속성 추출
        if (thText.includes('결제하기')) {
          const orderLink = row.querySelector('a#study_order');
          if (orderLink) {
            const price = orderLink.getAttribute('price');
            verification.priceField = price ? `${price}원` : null;
          }
        }
      }
      
      // 검증 로직
      if (!verification.mbInfo) {
        verification.errors.push('회원 정보를 찾을 수 없습니다');
      }
      if (!verification.roomName) {
        verification.errors.push('스터디룸 정보를 찾을 수 없습니다');
      }
      if (!verification.useTime) {
        verification.errors.push('이용시간 정보를 찾을 수 없습니다');
      }
      if (!verification.priceField) {
        verification.errors.push('결제금액 정보를 찾을 수 없습니다');
      }
      
      return verification;
    });

    log(`✅ [7-5] 예약 정보 추출 완료:`);
    log(`   회원: ${finalVerification.mbInfo || '(미확인)'}`);
    log(`   룸: ${finalVerification.roomName || '(미확인)'}`);
    log(`   시간: ${finalVerification.useTime || '(미확인)'}`);
    log(`   가격: ${finalVerification.priceField || '(미확인)'}`);
    
    // 🔴 추출 실패 시 즉시 중단
    if (finalVerification.errors.length > 0) {
      log(`❌ 검증 실패: ${finalVerification.errors.join(', ')}`);
      throw buildStageError('SAVE_FINAL_VERIFICATION_FAILED', `[7-5검증] 예약 정보 추출 실패: ${finalVerification.errors.join(', ')}`);
    }
    
    // 🟡 데이터 비교 검증
    log(`\n🔍 [7-6단계] 파싱 데이터와 비교:`);
    const comparisonErrors = [];
    
    // 번호 비교: 이재룡(010-3500-0586) → 괄호 안 숫자만 추출
    const phoneNoHyphen = PHONE_NOHYPHEN.replace(/\D/g, '');  // 01035000586
    const parenMatch = finalVerification.mbInfo.match(/\(([^)]+)\)/);
    const extractedPhoneDigits = parenMatch
      ? parenMatch[1].replace(/\D/g, '')           // 괄호 안에서 숫자만 추출
      : finalVerification.mbInfo.replace(/\D/g, ''); // 괄호 없으면 전체에서 추출
    if (extractedPhoneDigits !== phoneNoHyphen) {
      comparisonErrors.push(`번호 불일치: 픽코=${finalVerification.mbInfo}, 네이버=${PHONE_NOHYPHEN}`);
    }
    
    // 룸 비교: A1 ↔ 스터디룸A1
    if (!finalVerification.roomName.includes(ROOM)) {
      comparisonErrors.push(`룸 불일치: 픽코=${finalVerification.roomName}, 네이버=${ROOM}`);
    }
    
    // 날짜 비교: 2026년 02월 23일 ↔ 2026-02-23
    // DATE = "2026-02-23" → "2026년 02월 23일"로 변환 (월과 일에 0 포함)
    const [year, month, day] = DATE.split('-');
    const expectedDate = `${year}년 ${month}월 ${day}일`;  // "2026년 02월 23일"
    if (!finalVerification.useTime.includes(expectedDate)) {
      comparisonErrors.push(`날짜 불일치: 픽코=${finalVerification.useTime.slice(0, 20)}, 네이버=${expectedDate}`);
    }
    
    if (comparisonErrors.length > 0) {
      log(`❌ 데이터 불일치: ${comparisonErrors.join(', ')}`);
      throw buildStageError('SAVE_COMPARISON_FAILED', `[7-6검증] 파싱 데이터 불일치: ${comparisonErrors.join(', ')}`);
    }
    
    log(`✅ [7-6] 모든 데이터 일치 확인됨! 결제 진행 가능`);
    log(`   회원번호: ✅`);
    log(`   룸: ✅`);
    log(`   날짜: ✅`);

    if (SKIP_FINAL_PAYMENT) {
      log('\n⏸️ [7-7단계] 결제대기 등록 모드 — 결제 단계 생략');
      log(`✅ [SUCCESS] 픽코 예약 등록 완료 (결제대기 상태 유지)`);
      log(`📅 예약정보: ${PHONE_NOHYPHEN} / ${DATE} / ${chosen.start}~${chosen.end} / ${ROOM}`);

      const shouldCloseBrowser = MODE === 'ops' || (process.env.HOLD_BROWSER !== '1');
      if (shouldCloseBrowser) {
        log(`🔒 [종료] 브라우저 종료 (MODE=${MODE})`);
        try { await browser.close(); } catch (e) {
          log(`⚠️ 브라우저 종료 실패(무시): ${e.message}`);
        }
      } else {
        log(`🔍 [대기] 브라우저 유지 (MODE=${MODE}, HOLD_BROWSER=1) → 검증용`);
        log(`⏱️ 5분 대기 중... (완료 확인 후 Ctrl+C로 종료)`);
        await delay(300_000);
        try { await browser.close(); } catch (e) {}
      }

      await releaseLock();
      process.exit(3);
    }

    // ======================== 8단계: 결제(확정) ========================
    setStage('PAYMENT');
    log('\n[8단계] 결제(확정) 처리');

    const payBtnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
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

    const norm = (s) => (s ?? '').replace(/[\s,]/g, '').trim();

    const setTopPriceZero = async () => {
      const priceInp = await page.$('#od_add_item_price');
      if (!priceInp) return false;

      await priceInp.click({ clickCount: 3 });
      await delay(120);
      try { await page.keyboard.press('Meta+A'); } catch (e) {}
      try { await page.keyboard.press('Control+A'); } catch (e) {}
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
    };

    const setMemo = async () => {
      try {
        await page.$eval('#od_memo', (inp) => {
          inp.value = '';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.value = '네이버예약 결제';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return true;
      } catch (e) {
        log(`⚠️ 주문메모 입력 실패: ${e.message}`);
        return false;
      }
    };

    const clickCashMouse = async () => {
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

        const isChecked = await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
        log(`💳 현금 클릭 결과: checked=${isChecked}`);
        return isChecked;
      } catch (e) {
        log(`⚠️ 현금 선택 실패: ${e.message}`);
        return false;
      }
    };

    const readTotals = async () => {
      return await page.evaluate(() => {
        const v1 = document.querySelector('#od_add_item_price')?.value ?? null;
        const v2 = document.querySelector('input[name*="pay_list"][name*="price"]')?.value ?? null;
        const total = (document.querySelector('#od_total_price3')?.textContent || '').trim();
        return { od_add_item_price: v1, pay_list_price: v2, od_total_price3: total };
      });
    };

    const waitTotalZeroStable = async () => {
      for (let i = 0; i < 10; i++) {
        await delay(250);
        const s1 = await readTotals();
        await delay(250);
        const s2 = await readTotals();
        log(`🔁 총액 안정성 체크#${i + 1}: s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
        if (norm(s1.od_total_price3) === '0' && norm(s2.od_total_price3) === '0') return { ok: true, snap: s2 };
      }
      const last = await readTotals();
      return { ok: false, snap: last };
    };

    let cashOk = false;
    let priceOk = false;
    let memoOk = false;
    let totalText = '';

    if (SKIP_PRICE_ZERO) {
      // 실제 금액 현금 결제 (키오스크 결제 시뮬레이션)
      log('🧾 [8-2] 실제 금액 현금 결제 진행');
      const snap = await readTotals();
      totalText = snap?.od_total_price3 ?? '';
      log(`🔎 현재 결제금액: ${totalText}`);

      // [8-2] 현금 선택
      cashOk = await clickCashMouse();
      await delay(300);
    } else {
      for (let attempt = 1; attempt <= 2; attempt++) {
        log(`🧾 결제 입력 시도 #${attempt}`);

        priceOk = await setTopPriceZero();
        await delay(250);

        memoOk = await setMemo();
        await delay(250);

        cashOk = await clickCashMouse();
        await delay(250);

        const stable = await waitTotalZeroStable();
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
      note: '결제 사유(od_add_item_dsc)는 자동 고정'
    };

    log(`🧾 결제 모달 입력 결과: ${JSON.stringify(payModalResult)}`);

    if (!SKIP_PRICE_ZERO && norm(payModalResult.totalText) !== '0') {
      throw buildStageError('PAYMENT_TOTAL_VALIDATION_FAILED', `결제 중단: 총 결제금액이 0이 아님 (od_total_price3=${payModalResult.totalText})`);
    }

    await delay(300);

    const preClickReassertZero = async () => {
      try {
        await page.$eval('#od_add_item_price', (inp) => {
          inp.setAttribute('price', '0');
          inp.setAttribute('ea', '0');
        });
      } catch (e) {}

      try {
        await page.$eval('#od_total_price', (inp) => { inp.value = '0'; });
      } catch (e) {}

      try {
        const priceInp = await page.$('#od_add_item_price');
        if (priceInp) {
          await priceInp.click({ clickCount: 3 });
          await delay(80);
          try { await page.keyboard.press('Meta+A'); } catch (e) {}
          try { await page.keyboard.press('Control+A'); } catch (e) {}
          for (let k = 0; k < 8; k++) {
            await page.keyboard.press('Backspace');
            await delay(30);
          }
          await page.keyboard.type('0', { delay: 50 });
          await delay(80);
          await page.mouse.click(20, 20);
        }
      } catch (e) {}
    };

    const clickPayOrderMouse = async () => {
      await page.waitForSelector('#pay_order', { timeout: 5000 });
      const h = await page.$('#pay_order');
      if (!h) throw new Error('#pay_order 핸들 없음');
      await page.evaluate(() => document.querySelector('#pay_order')?.scrollIntoView({ block: 'center' }));
      await delay(150);
      const box = await h.boundingBox();
      if (!box) throw new Error('#pay_order boundingBox 없음');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    };

    const modalClosed = async () => {
      return await page.evaluate(() => {
        return !document.querySelector('#order_write');
      });
    };

    let paySubmitClicked = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`🧾 결제하기 클릭 시도 #${attempt}`);
      if (!SKIP_PRICE_ZERO) await preClickReassertZero();

      try {
        paySubmitClicked = await clickPayOrderMouse();
      } catch (e) {
        log(`⚠️ 결제하기 클릭 실패: ${e.message}`);
        paySubmitClicked = false;
      }

      await delay(600);

      const closed = await modalClosed();
      const after = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
      log(`🔍 클릭 후 상태: modalClosed=${closed}, od_total_price3=${after}`);

      if (closed) break;
      if (SKIP_PRICE_ZERO) break; // 금액 체크 스킵
      if (norm(after) === '0') break;

      log('⚠️ 결제 클릭 후 총액이 원복된 것으로 보임. 0 재입력 후 재시도합니다...');
      await delay(400);
    }

    log(paySubmitClicked ? '✅ 모달 결제하기 클릭' : '⚠️ 모달 결제하기 버튼 클릭 실패');

    await delay(800);

    // [8-5] 결제완료 팝업 확인
    // setupDialogHandler가 native alert는 자동 처리 — DOM 기반 팝업 추가 처리
    const finalConfirm = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      const confirmBtn = btns.find(b => {
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

    log('\n✅ 완료! (등록+확정(결제) 처리까지 완료)');
    
    // ======================== 9단계: 완료 확인 ========================
    setStage('FINAL_CONFIRM');
    log('\n[9단계] 픽코 예약등록 + 결제 완료 확인');
    
    const finalStatus = await page.evaluate(() => {
      const pageTitle = document.title || '';
      const hasErrorMsg = !!document.querySelector('body')?.innerText.includes('에러');
      const hasSuccessMsg = !!document.querySelector('body')?.innerText.includes('완료');
      
      return {
        pageTitle,
        hasErrorMsg,
        hasSuccessMsg,
        url: window.location.href,
        timestamp: new Date().toLocaleString('ko-KR')
      };
    });
    
    log(`🔍 최종 상태: ${JSON.stringify(finalStatus)}`);

    // ✅ URL이 #/order/view/{숫자}로 바뀌면 결제 완료 확정 (가장 신뢰할 수 있는 지표)
    const hasOrderUrl = /\/order\/view\/\d+/.test(finalStatus.url);
    // paySubmitClicked 단독으로는 불충분 — URL 변경 또는 성공 메시지 필요
    const isSuccess = !finalStatus.hasErrorMsg && (hasOrderUrl || finalStatus.hasSuccessMsg);

    if (isSuccess) {
      log(`✅ [SUCCESS] 픽코 예약등록 + 결제 완료됨!`);
      log(`📅 예약정보: ${PHONE_NOHYPHEN} / ${DATE} / ${chosen.start}~${chosen.end} / ${ROOM}`);
      log(`💳 결제: ${payModalResult.totalText}원 (0원 현금결제)`);
    } else if (paySubmitClicked) {
      log(`⚠️ [WARNING] 결제 버튼 클릭됐으나 완료 미확인 (URL: ${finalStatus.url})`);
      log(`⚠️ [WARNING] 수동 확인 필요 — 픽코 관리자에서 결제 상태 확인 바랍니다`);
    } else {
      log(`⚠️ [WARNING] 완료 상태 불명확 (수동 확인 필요)`);
    }

    // ─────────────────────────────────────────────────────────────
    // 🔐 브라우저 종료 로직 (OPS vs DEV)
    // ─────────────────────────────────────────────────────────────
    // OPS 모드: 항상 종료 (실제 운영)
    // DEV 모드: HOLD_BROWSER=1이면 유지 (검증용)
    
    const shouldCloseBrowser = MODE === 'ops' || (process.env.HOLD_BROWSER !== '1');
    
    if (shouldCloseBrowser) {
      log(`🔒 [종료] 브라우저 종료 (MODE=${MODE})`);
      try { await browser.close(); } catch (e) {
        log(`⚠️ 브라우저 종료 실패(무시): ${e.message}`);
      }
    } else {
      log(`🔍 [대기] 브라우저 유지 (MODE=${MODE}, HOLD_BROWSER=1) → 검증용`);
      log(`⏱️ 5분 대기 중... (완료 확인 후 Ctrl+C로 종료)`);
      await delay(300_000);
      try { await browser.close(); } catch (e) {}
    }

    // ✅ 정상 종료 (브라우저 close 이후 발생하는 Detached Frame 오류가
    //    catch 블록으로 전파되어 exit(1)로 오인되는 것을 방지)
    await releaseLock();
    process.exit(0);

  } catch (err) {
    // ⏰ 시간 경과로 등록 불가 (exit 2) — 완료로 간주, retry 없음
    if (err.code === 'TIME_ELAPSED') {
      logStageFailure('TIME_ELAPSED', err.message, { currentStage });
      log(`⏰ [시간 경과] 픽코 등록 생략: ${err.message}`);
      try { await browser.close(); } catch(e) {}
      await releaseLock();
      process.exit(2);
    }

    // ⚠️ 슬롯에 동일 고객이 이미 등록됨
    if (err.code === 'ALREADY_REGISTERED') {
      logStageFailure('ALREADY_REGISTERED', err.message, { currentStage });
      if (SKIP_FINAL_PAYMENT) {
        log(`⚠️ [이미 등록됨] 결제대기 모드 유지 — 결제 단계 생략: ${err.message}`);
        try { await browser.close(); } catch(e) {}
        await releaseLock();
        process.exit(3);
      }

      log(`⚠️ [이미 등록됨] 결제대기 여부 확인 → pickko-pay-pending.js 실행: ${err.message}`);
      try { await browser.close(); } catch(e) {}
      await releaseLock();

      await new Promise((resolve) => {
        const child = spawn('node', [
          path.join(__dirname, '../reports/pickko-pay-pending.js'),
          `--phone=${PHONE_NOHYPHEN}`,
          `--date=${DATE}`,
          `--start=${START_TIME}`,
          `--end=${END_TIME}`,
          `--room=${ROOM}`,
        ], {
          cwd: __dirname,
          env: { ...process.env, MODE: process.env.MODE || 'ops' },
          stdio: ['ignore', process.stdout, process.stderr],
        });
        child.on('close', resolve);
        child.on('error', (e) => { log(`⚠️ pickko-pay-pending 실행 오류: ${e.message}`); resolve(1); });
      });

      process.exit(0);
    }

    logStageFailure(err.stageCode || currentStage || 'UNKNOWN_STAGE', err.message, { currentStage });
    log(`❌ 에러 발생: ${err.message}`);

    // 🔐 **OPS 모드 오류 처리**
    if (MODE === 'ops') {
      log(`\n🚨 [OPS-ERROR] 예약 처리 중 오류 발생`);
      log(`━━━━━━━━━━━━━━━`);
      log(`❌ 오류: ${err.message}`);
      log(`📞 고객: ${PHONE_NOHYPHEN}`);
      log(`📅 날짜: ${DATE}`);
      log(`⏰ 시간: ${START_TIME}~${END_TIME}`);
      log(`🏛️ 룸: ${ROOM}`);
      log(`━━━━━━━━━━━━━━━`);
      log(`⚠️ 조치: 즉시 DEV 모드로 전환하여 분석 필요`);
      log(`⚠️ 최우선 해결 과제로 등록되었습니다.`);

      // 추후 텔레그램 알람 연동
      // await sendAlert({
      //   title: '🚨 [OPS-ERROR]',
      //   error: err.message,
      //   phone: PHONE_NOHYPHEN,
      //   date: DATE,
      //   action: 'DEV 모드로 전환 필요'
      // });

      // OPS 모드: 항상 브라우저 종료
      try { await browser.close(); } catch (e) {}
      await releaseLock();
      process.exit(1);
    }

    // 🟡 **DEV 모드 오류 처리**
    else {
      log(`⚠️ [DEV] 예약 처리 중 오류 (개발 중이므로 로그만 출력)`);

      if (process.env.HOLD_BROWSER_ON_ERROR === '0') {
        log('🧹 HOLD_BROWSER_ON_ERROR=0 → 에러여도 브라우저 종료');
        try { await browser.close(); } catch (e) {}
      } else {
        log('🛑 에러 발생: 브라우저를 닫지 않고 대기합니다. (직접 화면 확인 후 알려주세요)');
        await delay(600_000);
        try { await browser.close(); } catch (e) {}
      }
      await releaseLock();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Main 실행 중 예외:', err);
  process.exit(1);
});
