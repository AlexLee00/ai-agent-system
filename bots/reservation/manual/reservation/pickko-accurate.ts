#!/usr/bin/env node
/// <reference lib="dom" />

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
const { loadSecrets, getSecret, initHubSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { maskPhone, maskName } = require('../../lib/formatting');
const {
  acquirePickkoLock,
  releasePickkoLock,
  setManualPickkoPriority,
  clearManualPickkoPriority,
} = require('../../lib/state-bus');
const { publishReservationAlert } = require('../../lib/alert-client');
const { createPickkoMemberService } = require('../../lib/pickko-member-service');
const {
  timeToSlots,
  buildSlotCandidates,
  adjustEffectiveTimeSlots,
} = require('../../lib/pickko-slot-helpers');
const { createPickkoPaymentService } = require('../../lib/pickko-payment-service');
const { createPickkoDateService } = require('../../lib/pickko-date-service');
const { createPickkoMemberSelectionService } = require('../../lib/pickko-member-selection-service');
const { createPickkoRoomSlotService } = require('../../lib/pickko-room-slot-service');
const { createPickkoFinalizationService } = require('../../lib/pickko-finalization-service');
const { createPickkoSavePrecheckService } = require('../../lib/pickko-save-precheck-service');
const { IS_DEV, IS_OPS } = require('../../../../packages/core/lib/env');

type StageError = Error & {
  stageCode?: string;
  code?: string;
};

function buildStageError(code: string, message: string): StageError {
  const error = new Error(message) as StageError;
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

loadSecrets();

const DEFAULTS = {
  date: '2026-07-05',
  start: '19:00',
  end: '20:00',
  room: 'A1',
  phone: '01035000586',
};

const ARGS = parseArgs(process.argv);
const CUSTOMER_NAME = (ARGS.name || '고객').replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';

const rawInput = {
  phone: ARGS.phone || DEFAULTS.phone,
  date: ARGS.date || DEFAULTS.date,
  start: ARGS.start || DEFAULTS.start,
  end: ARGS.end || DEFAULTS.end,
  room: ARGS.room || DEFAULTS.room,
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

const MODE = IS_OPS ? 'ops' : 'dev';
const ENABLE_NAME_SYNC = process.env.ENABLE_NAME_SYNC === '1';
const SKIP_NAME_SYNC =
  process.env.SKIP_NAME_SYNC === '1' ||
  process.env.MANUAL_RETRY === '1' ||
  !ENABLE_NAME_SYNC;
const SKIP_FINAL_PAYMENT = process.env.SKIP_FINAL_PAYMENT === '1';
const SKIP_PRICE_ZERO = process.env.SKIP_PRICE_ZERO === '1';
const MANUAL_PICKKO_LOCK_TTL_MS = 20 * 60 * 1000;
const MANUAL_PICKKO_LOCK_WAIT_MS = 90 * 1000;
const MANUAL_PICKKO_LOCK_RETRY_MS = 5 * 1000;

const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => /^\d{11}$/.test(p));

log(`📋 DEV 화이트리스트: [${DEV_WHITELIST.join(', ')}]`);
log(`🔧 MODE: ${MODE.toUpperCase()} ${MODE === 'dev' ? '(테스트 모드 - 화이트리스트만 허용)' : '(운영 모드 - 모든 번호 허용)'}`);
log(`📞 입력 번호: ${PHONE_NOHYPHEN}`);

if (IS_DEV) {
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
  log('🚀 OPS 모드: 모든 번호 허용 (테스트 완료 후 전환됨)');
  log('⚠️  주의: OPS 모드 전환은 사장님과 스카의 협의로만 진행됩니다');
}

const ROOM_ID = {
  A1: '206482',
  A2: '206450',
  B: '206487',
};

function addMinutesHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = String(Math.floor((total % (24 * 60)) / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function sendErrorNotification(errorMsg, context = {}) {
  log(`🚨 ERROR: ${errorMsg}`);
  log(`📋 컨텍스트: ${JSON.stringify(context)}`);
}

const pickkoMemberService = createPickkoMemberService({
  delay,
  log,
  maskName,
  maskPhone,
  publishReservationAlert,
});
const pickkoPaymentService = createPickkoPaymentService({
  delay,
  log,
});
const pickkoDateService = createPickkoDateService({
  delay,
  log,
  sendErrorNotification,
  buildStageError,
});
const pickkoMemberSelectionService = createPickkoMemberSelectionService({
  delay,
  log,
  maskName,
  maskPhone,
  sendErrorNotification,
  buildStageError,
  registerNewMember,
});
const pickkoRoomSlotService = createPickkoRoomSlotService({
  delay,
  log,
  maskPhone,
  buildStageError,
});
const pickkoFinalizationService = createPickkoFinalizationService({
  log,
  buildStageError,
});
const pickkoSavePrecheckService = createPickkoSavePrecheckService({
  log,
  buildStageError,
});

async function notifyMemberNameMismatch(phoneRaw, pickkoName, naverName, mbNo = null) {
  return pickkoMemberService.notifyMemberNameMismatch(phoneRaw, pickkoName, naverName, mbNo);
}

async function registerNewMember(page, phoneNoHyphen, customerName, reservationDate) {
  return pickkoMemberService.registerNewMember(page, phoneNoHyphen, customerName, reservationDate);
}

async function main() {
  let browser;
  let lockAcquired = false;
  let currentStage = 'INIT';
  const setStage = (stage) => {
    currentStage = stage;
    log(`📍 단계 진입: ${stage}`);
  };

  const releaseLock = async () => {
    if (lockAcquired) {
      try { await releasePickkoLock('manual'); log('🔓 픽코 락 해제'); } catch {}
      lockAcquired = false;
    }
    try { await clearManualPickkoPriority(); } catch {}
  };

  try {
    await initHubSecrets();
    log('🚀 픽코 예약 등록 시작');
    await setManualPickkoPriority('manual_reservation');

    setStage('LOCK_ACQUIRE');
    const lockDeadline = Date.now() + MANUAL_PICKKO_LOCK_WAIT_MS;
    while (!lockAcquired && Date.now() < lockDeadline) {
      lockAcquired = await acquirePickkoLock('manual', MANUAL_PICKKO_LOCK_TTL_MS);
      if (lockAcquired) break;
      const remainingSec = Math.max(0, Math.ceil((lockDeadline - Date.now()) / 1000));
      log(`⏳ 픽코 수동 우선 락 대기 중... 남은 ${remainingSec}초`);
      await delay(MANUAL_PICKKO_LOCK_RETRY_MS);
    }
    if (!lockAcquired) {
      logStageFailure('LOCK_CONFLICT', '픽코 락 획득 실패', { mode: MODE, waitedMs: MANUAL_PICKKO_LOCK_WAIT_MS });
      log('⚠️ 픽코 락 획득 실패 — 자동 에이전트 점유가 길어 수동 등록을 시작하지 못했습니다.');
      process.exit(1);
    }
    log(`🔒 픽코 락 획득 (manual, ttl=${Math.floor(MANUAL_PICKKO_LOCK_TTL_MS / 60000)}m)`);

    browser = await puppeteer.launch(getPickkoLaunchOptions());

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    page.setDefaultTimeout(30000);

    await delay(500);
    setupDialogHandler(page, log);

    setStage('LOGIN');
    log('\n[1단계] 로그인');
    await loginToPickko(page, getSecret('pickko_id', ''), getSecret('pickko_pw', ''), delay);
    log('✅ 로그인 완료');

    const timeRangeCheck = validateTimeRange(START_TIME, END_TIME);
    if (!timeRangeCheck.ok) {
      throw new Error(`시간 변환 실패: ${timeRangeCheck.error}`);
    }
    log(`✅ 시간 변환 완료: ${START_TIME} ~ ${END_TIME}${timeRangeCheck.isCrossMidnight ? ' (자정 넘어감)' : ''}`);

    setStage('OPEN_STUDY_WRITE');
    log('\n[2단계] 예약 등록 페이지');
    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);

    setStage('MEMBER_SEARCH');
    await pickkoMemberSelectionService.runMemberSearch(page, PHONE_NOHYPHEN);

    setStage('MEMBER_SELECT');
    log('\n[4단계] 회원 선택');

    const selectedMemberInfo = await pickkoMemberSelectionService.verifyAndSelectMember(page, {
      phoneNoHyphen: PHONE_NOHYPHEN,
      customerName: CUSTOMER_NAME,
      date: DATE,
    });

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
          null,
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

    setStage('DATE_SELECT');
    log('\n[5단계] 날짜 확인');
    await pickkoDateService.setAndVerifyDate(page, { date: DATE });

    const TIME_SLOTS = timeToSlots(START_TIME, END_TIME);
    log(`🔄 [30분 단위 슬롯 변환] ${START_TIME}~${END_TIME} → [${TIME_SLOTS.join(', ')}] (${TIME_SLOTS.length}개)`);

    const adjustedSlots = adjustEffectiveTimeSlots(DATE, TIME_SLOTS);
    let effectiveTimeSlots = adjustedSlots.effectiveTimeSlots;

    if (adjustedSlots.skippedCount > 0) {
      log(`⏰ [6-0] 경과 슬롯 ${adjustedSlots.skippedCount}개 스킵 (현재 ${adjustedSlots.nowText}): ${TIME_SLOTS[0]}~${TIME_SLOTS[TIME_SLOTS.length - 1]} → 유효: [${effectiveTimeSlots.join(', ')}]`);
      if (effectiveTimeSlots.length < 2) {
        const elapsedErr = new Error(`${START_TIME}~${END_TIME} (현재 ${adjustedSlots.nowText}) — 남은 유효 슬롯 없음`) as StageError;
        elapsedErr.code = 'TIME_ELAPSED';
        throw elapsedErr;
      }
    }

    setStage('ROOM_AND_SLOT_SELECT');
    const stNo = ROOM_ID[ROOM];
    if (!stNo) throw buildStageError('ROOM_MAPPING_FAILED', `ROOM_ID 매핑 없음: ROOM=${ROOM}`);
    const slotCandidates = buildSlotCandidates(effectiveTimeSlots);
    const chosen = await pickkoRoomSlotService.selectRoomAndSlot(page, {
      date: DATE,
      room: ROOM,
      stNo,
      timeSlots: TIME_SLOTS,
      effectiveTimeSlots,
      slotCandidates,
      customerName: CUSTOMER_NAME,
      phoneNoHyphen: PHONE_NOHYPHEN,
      mode: MODE,
    });

    log('[6-6] 선택 검증 (input 필드 확인)');
    await delay(1000);

    const timeVerification = await page.evaluate(() => {
      const startDateInput = document.querySelector('input#start_date') as HTMLInputElement | null;
      const startTimeInput = document.querySelector('input#start_time') as HTMLInputElement | null;
      const endDateInput = document.querySelector('input#end_date') as HTMLInputElement | null;
      const endTimeInput = document.querySelector('input#end_time') as HTMLInputElement | null;
      const inps = {
        start_date: startDateInput?.value || '',
        start_time: startTimeInput?.value || '',
        end_date: endDateInput?.value || '',
        end_time: endTimeInput?.value || '',
      };

      return {
        hasStartDate: !!inps.start_date,
        hasStartTime: !!inps.start_time,
        hasEndDate: !!inps.end_date,
        hasEndTime: !!inps.end_time,
        values: inps,
      };
    });

    log(`       ├─ start_date: ${timeVerification.values.start_date || '(empty)'} ${timeVerification.hasStartDate ? '✅' : '❌'}`);
    log(`       ├─ start_time: ${timeVerification.values.start_time || '(empty)'} ${timeVerification.hasStartTime ? '✅' : '❌'}`);
    log(`       ├─ end_date: ${timeVerification.values.end_date || '(empty)'} ${timeVerification.hasEndDate ? '✅' : '❌'}`);
    log(`       └─ end_time: ${timeVerification.values.end_time || '(empty)'} ${timeVerification.hasEndTime ? '✅' : '❌'}`);

    if (!timeVerification.hasStartTime || !timeVerification.hasEndTime) {
      log('⚠️ 경고: 시간이 input 필드에 반영되지 않았을 수 있습니다. 계속 진행합니다.');
    }

    await delay(1500);

    setStage('SAVE_PRECHECK');
    log('\n[7단계] 저장');
    await pickkoSavePrecheckService.runSavePrecheck(page);
    await pickkoSavePrecheckService.submitDraft(page);

    await delay(1500);

    await pickkoFinalizationService.verifyReservationDraft(page, {
      date: DATE,
      room: ROOM,
      phoneNoHyphen: PHONE_NOHYPHEN,
    });

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
        log('🔍 [대기] 브라우저 유지 (MODE=${MODE}, HOLD_BROWSER=1) → 검증용');
        log('⏱️ 5분 대기 중... (완료 확인 후 Ctrl+C로 종료)');
        await delay(300_000);
        try { await browser.close(); } catch (e) {}
      }

      await releaseLock();
      process.exit(3);
    }

    setStage('PAYMENT');
    log('\n[8단계] 결제(확정) 처리');

    const {
      payModalResult,
      paySubmitClicked,
    } = await pickkoPaymentService.processPaymentStep(page, {
      skipPriceZero: SKIP_PRICE_ZERO,
      buildStageError,
    });

    log('\n✅ 완료! (등록+확정(결제) 처리까지 완료)');

    setStage('FINAL_CONFIRM');
    log('\n[9단계] 픽코 예약등록 + 결제 완료 확인');

    const finalStatus = await pickkoFinalizationService.readFinalStatus(page);
    const isSuccess = finalStatus.isSuccess;

    if (isSuccess) {
      log('✅ [SUCCESS] 픽코 예약등록 + 결제 완료됨!');
      log(`📅 예약정보: ${PHONE_NOHYPHEN} / ${DATE} / ${chosen.start}~${chosen.end} / ${ROOM}`);
      log(`💳 결제: ${payModalResult.totalText}원 (0원 현금결제)`);
    } else if (paySubmitClicked) {
      log(`⚠️ [WARNING] 결제 버튼 클릭됐으나 완료 미확인 (URL: ${finalStatus.url})`);
      log('⚠️ [WARNING] 수동 확인 필요 — 픽코 관리자에서 결제 상태 확인 바랍니다');
    } else {
      log('⚠️ [WARNING] 완료 상태 불명확 (수동 확인 필요)');
    }

    const shouldCloseBrowser = MODE === 'ops' || (process.env.HOLD_BROWSER !== '1');
    if (shouldCloseBrowser) {
      log(`🔒 [종료] 브라우저 종료 (MODE=${MODE})`);
      try { await browser.close(); } catch (e) {
        log(`⚠️ 브라우저 종료 실패(무시): ${e.message}`);
      }
    } else {
      log('🔍 [대기] 브라우저 유지 (MODE=${MODE}, HOLD_BROWSER=1) → 검증용');
      log('⏱️ 5분 대기 중... (완료 확인 후 Ctrl+C로 종료)');
      await delay(300_000);
      try { await browser.close(); } catch (e) {}
    }

    await releaseLock();
    process.exit(0);
  } catch (err) {
    if (err.code === 'TIME_ELAPSED') {
      logStageFailure('TIME_ELAPSED', err.message, { currentStage });
      log(`⏰ [시간 경과] 픽코 등록 생략: ${err.message}`);
      try { await browser.close(); } catch (e) {}
      await releaseLock();
      process.exit(2);
    }

    if (err.code === 'ALREADY_REGISTERED') {
      logStageFailure('ALREADY_REGISTERED', err.message, { currentStage });
      if (SKIP_FINAL_PAYMENT) {
        log(`⚠️ [이미 등록됨] 결제대기 모드 유지 — 결제 단계 생략: ${err.message}`);
        try { await browser.close(); } catch (e) {}
        await releaseLock();
        process.exit(3);
      }

      log(`⚠️ [이미 등록됨] 결제대기 여부 확인 → pickko-pay-pending.js 실행: ${err.message}`);
      try { await browser.close(); } catch (e) {}
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
          env: { ...process.env, MODE: IS_OPS ? 'ops' : 'dev' },
          stdio: ['ignore', process.stdout, process.stderr],
        });
        child.on('close', resolve);
        child.on('error', (e) => {
          log(`⚠️ pickko-pay-pending 실행 오류: ${e.message}`);
          resolve(1);
        });
      });

      process.exit(0);
    }

    logStageFailure(err.stageCode || currentStage || 'UNKNOWN_STAGE', err.message, { currentStage });
    log(`❌ 에러 발생: ${err.message}`);

    if (MODE === 'ops') {
      log('\n🚨 [OPS-ERROR] 예약 처리 중 오류 발생');
      log('━━━━━━━━━━━━━━━');
      log(`❌ 오류: ${err.message}`);
      log(`📞 고객: ${PHONE_NOHYPHEN}`);
      log(`📅 날짜: ${DATE}`);
      log(`⏰ 시간: ${START_TIME}~${END_TIME}`);
      log(`🏛️ 룸: ${ROOM}`);
      log('━━━━━━━━━━━━━━━');
      log('⚠️ 조치: 즉시 DEV 모드로 전환하여 분석 필요');
      log('⚠️ 최우선 해결 과제로 등록되었습니다.');

      try { await browser.close(); } catch (e) {}
      await releaseLock();
      process.exit(1);
    }

    log('⚠️ [DEV] 예약 처리 중 오류 (개발 중이므로 로그만 출력)');
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

module.exports = {
  buildStageError,
  logStageFailure,
  notifyMemberNameMismatch,
  registerNewMember,
  main,
};

main().catch((err) => {
  console.error('Main 실행 중 예외:', err);
  process.exit(1);
});
