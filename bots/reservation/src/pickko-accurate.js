#!/usr/bin/env node

/**
 * 픽코 예약 등록 (외부 모니터 + 팝업 자동 처리)
 * 010-3500-0586 / 2026-02-22 / 02:30~03:00 / A1룸
 * 
 * ✅ VALIDATION_RULES.md에 정의된 검증 규칙 적용
 * ✅ lib/validation.js 라이브러리 사용
 */

const puppeteer = require('puppeteer');
const { validateAndNormalizeData, validateTimeRange } = require('../lib/validation');

async function initializeBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1440,900'
        ]
    });
    return browser;
}
// NOTE: 창 위치/모니터 이동 로직은 제거 (macOS 스케일/권한 이슈로 불안정)


const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';
// ======================== 입력 파라미터 ========================
// 기본값(테스트용). 운영 연결 시 naver-monitor에서 argv로 주입.
const DEFAULTS = {
  date: '2026-07-05',
  start: '19:00',
  end: '20:00',
  room: 'A1',
  phone: '01035000586'
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, vRaw] = a.slice(2).split('=');
    const v = vRaw ?? argv[i + 1];
    if (vRaw === undefined) i++;
    out[k] = v;
  }
  return out;
}

const ARGS = parseArgs(process.argv);

// ✅ 입력 데이터 검증 (VALIDATION_RULES.md 규칙 적용)
const rawInput = {
  phone: ARGS.phone || DEFAULTS.phone,
  date: ARGS.date || DEFAULTS.date,
  start: ARGS.start || DEFAULTS.start,
  end: ARGS.end || DEFAULTS.end,
  room: ARGS.room || DEFAULTS.room
};

const validated = validateAndNormalizeData(rawInput);
if (!validated) {
  throw new Error(`입력 데이터 검증 실패: ${JSON.stringify(rawInput)}`);
}

const PHONE_NOHYPHEN = validated.phone;
const DATE = validated.date;
const START_TIME = validated.start;
const END_TIME = validated.end;
const ROOM = validated.room;

// ✅ DEV 모드 화이트리스트 검증 (2026-02-23)
// 환경변수: DEV_WHITELIST_PHONES="01035000586,01054350586"
// 기본값: 이재룡(사장님), 김정민(부사장님)
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map(p => p.trim())
  .filter(p => /^\d{11}$/.test(p));

log(`📋 DEV 화이트리스트: [${DEV_WHITELIST.join(', ')}]`);

const MODE = (process.env.MODE || 'dev').toLowerCase();
if (MODE === 'dev' && !DEV_WHITELIST.includes(PHONE_NOHYPHEN)) {
  throw new Error(`🔐 DEV 모드 화이트리스트 검증 실패: ${PHONE_NOHYPHEN}은(는) 테스트 대상이 아닙니다. (허용: ${DEV_WHITELIST.join(', ')})`);
}


// 룸명 → st_no (사장님 제공 HTML 기반)
const ROOM_ID = {
  A1: '206482',
  A2: '206450',
  B:  '206487'
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function addMinutesHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = String(Math.floor((total % (24 * 60)) / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ✅ AM/PM 시간 → 24시간 형식 변환
// 규칙: 오전 12:XX → 00:XX (자정)
//      오후 12:XX → 12:XX (정오)
//      나머지는 표준 12시간→24시간 변환
function convertAMPMto24Hour(ampmTime, period) {
  // ampmTime: "12:00", period: "오전" or "오후"
  if (!ampmTime || !period) return ampmTime;
  
  const [h, m] = ampmTime.split(':').map(Number);
  let hour = h;
  
  if (period.includes('오전')) {
    // 오전 12:XX → 00:XX (자정)
    if (h === 12) hour = 0;
  } else if (period.includes('오후')) {
    // 오후 12:XX → 12:XX (정오)
    if (h !== 12) hour = h + 12;
  }
  
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ✅ 시간 검증은 lib/validation.js의 validateTimeRange 사용
// (중복 제거 및 라이브러리 일관성)

// ✅ 오류 발생 시 알림 (텔레그램/로그)
async function sendErrorNotification(errorMsg, context = {}) {
  log(`🚨 ERROR: ${errorMsg}`);
  log(`📋 컨텍스트: ${JSON.stringify(context)}`);
  
  // 추후 텔레그램 알림 연동 가능
  // await notifyTelegram(errorMsg, context);
}

// (창 이동 기능 제거)

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function main() {
  let browser;
  
  try {
    log(`🚀 픽코 예약 등록 시작 (외부 모니터 전체화면)`);
    
    // 브라우저 실행 (왼쪽 Thunderbolt Display(2)로 고정 + 전체화면)
    // 모니터 배치(사장님 제공): 내장(2560x1440) + 왼쪽 TB(2048x1152) + 오른쪽 TB(1920x1080)
    browser = await puppeteer.launch({
      headless: false,
      // ✅ 느린 환경/무거운 페이지에서 CDP 함수 호출 타임아웃 완화 (기본 180초)
      protocolTimeout: parseInt(process.env.PICKKO_PROTOCOL_TIMEOUT_MS || '180000', 10),
      args: [
        '--no-sandbox',
        // 맥북 화면에서 최대한 꽉 차게(전체화면/kiosk는 아님)
        '--window-position=0,25',
        '--window-size=2200,1300',
        '--start-maximized'
      ],
      defaultViewport: null
    });
    
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    page.setDefaultTimeout(30000);

    // 🖥️ 창 이동/모니터 제어 로직 제거 (맥북 화면에서만 실행)
    await delay(500);

    // ✅ 등록 완료/오류 alert 팝업 자동 "확인" (window.alert/confirm)
    page.on('dialog', async (dialog) => {
      try {
        log(`🧾 팝업 감지: ${dialog.message()}`);
        await dialog.accept();
        log('✅ 팝업 확인(accept) 클릭 완료');
      } catch (e) {
        log(`⚠️ 팝업 처리 실패: ${e.message}`);
      }
    });
    
    // ======================== 1단계: 로그인 ========================
    log('\n[1단계] 로그인');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
    
    await page.evaluate((id, pw) => {
      document.getElementById('mn_id').value = id;
      document.getElementById('mn_pw').value = pw;
      document.getElementById('loginButton').click();
    }, PICKKO_ID, PICKKO_PW);
    
    await delay(3000);
    log('✅ 로그인 완료');
    
    // ✅ 시간 범위 검증 (로그인 후)
    const timeRangeCheck = validateTimeRange(START_TIME, END_TIME);
    if (!timeRangeCheck.ok) {
      throw new Error(`시간 검증 실패: ${timeRangeCheck.error}`);
    }
    log(`✅ 시간 검증 통과: ${START_TIME} ~ ${END_TIME}${timeRangeCheck.isCrossMidnight ? ' (자정 넘어감)' : ''}`);
    
    // ======================== 2단계: 페이지 이동 ========================
    log('\n[2단계] 예약 등록 페이지');
    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    
    // ======================== 3단계: 회원 검색 ========================
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
    
    // ======================== 4단계: 회원 선택 ========================
    log('\n[4단계] 회원 선택');
    
    // 1. "회원 선택" 버튼 클릭
    try {
        await page.click('a#mb_select_btn');
    } catch (e) {
        log('⚠️ ID 클릭 실패, 대체 시도...');
        await page.evaluate(() => {
            const links = document.querySelectorAll('a.btn_box');
            for (const a of links) if (a.textContent.includes('회원 선택')) a.click();
        });
    }
    await delay(2000);
    
    // 2. 모달 내 "선택" 버튼 클릭
    const memberSelectResult = await page.evaluate(() => {
        const selectBtn = document.querySelector('a.mb_select');
        if (selectBtn) {
            selectBtn.click();
            return true;
        }
        return false;
    });
    
    if (memberSelectResult) log('✅ 최종 회원 선택 완료');
    else log('⚠️ 모달 내 선택 버튼 실패');
    
    await delay(2000);
    
    // ======================== 5단계: 날짜 확인 (수정됨) ========================
    log('\n[5단계] 날짜 확인');
    
    // 1) 예약일자 읽기 (li#prev_schedule)
    const prevScheduleDate = await page.evaluate(() => {
        const li = document.querySelector('li#prev_schedule');
        return li ? li.textContent.trim() : '';
    });
    
    // 2) 입력필드(start_date) 현재값 읽기
    const inputDate = await page.evaluate(() => {
        const inp = document.querySelector('input#start_date');
        return inp ? inp.value : '';
    });
    
    log(`📅 예약일자(prev_schedule): ${prevScheduleDate}`);
    log(`📅 입력필드(start_date): ${inputDate}`);
    log(`📅 목표 날짜(DATE): ${DATE}`);
    
    // 3) 비교: 예약일자와 입력필드가 같으면 스킵, 다르면 날짜 설정
    if (inputDate === prevScheduleDate) {
        log(`✅ 입력필드(${inputDate})가 예약일자(${prevScheduleDate})와 같습니다. 날짜 설정 스킵!`);
    } else {
        // 요청: 코드로 날짜를 먼저 세팅하고, 달력 팝업을 띄운 뒤 해당 "일자"를 클릭해서 확정
        log(`⚠️ 날짜가 다릅니다. 1) 코드로 ${DATE} 세팅 → 2) 달력 팝업 확인 → 3) 일자 클릭 확정`);

        // 1) 코드로 날짜 세팅 (+ datepicker setDate)
        const setDateResult = await page.evaluate((dateStr) => {
          const inp = document.querySelector('input#start_date');
          if (!inp) return { ok: false, reason: 'no #start_date' };

          inp.focus();
          inp.value = dateStr;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));

          try {
            if (window.jQuery && window.jQuery.fn && window.jQuery.fn.datepicker) {
              window.jQuery(inp).datepicker('setDate', dateStr);
              window.jQuery(inp).trigger('change');
            }
          } catch (e) {}

          return { ok: true, value: inp.value };
        }, DATE);

        log(`📅 날짜 세팅(코드) 결과: ${JSON.stringify(setDateResult)}`);

        // 2) 달력 팝업 오픈
        await page.click('input#start_date');
        await delay(600);

        // 3) 달력에서 목표 날짜 클릭(연/월/일 정확히)
        const [ty, tm, td] = DATE.split('-').map(n => parseInt(n, 10));
        const clicked = await page.evaluate((year, month1, day) => {
          const m0 = month1 - 1; // jQuery UI: data-month 0-based
          // td[data-handler=selectDay][data-year][data-month] 안의 a 텍스트가 day인 것 클릭
          const cells = document.querySelectorAll(`td[data-handler="selectDay"][data-year="${year}"][data-month="${m0}"] a`);
          for (const a of cells) {
            if (a.textContent.trim() === String(day)) {
              a.click();
              return true;
            }
          }
          return false;
        }, ty, tm, td);

        log(clicked ? `✅ 달력에서 ${tm}월 ${td}일 클릭 완료` : `⚠️ 달력에서 ${tm}월 ${td}일 클릭 실패(팝업 구조 확인 필요)`);

        await delay(1200); // 클릭 후 스케줄 표 갱신 대기

        // 최종 검증
        const after = await page.evaluate(() => document.querySelector('input#start_date')?.value || '');
        if (after !== DATE) {
          log(`⚠️ 날짜 검증 실패: start_date=${after} (expected ${DATE})`);
        } else {
          log(`✅ 날짜 검증 성공: ${after}`);
        }
    }
    
    // ======================== 6단계: 룸 & 시간 선택 ========================
    log('\n[6단계] 룸 & 시간 선택');
    
    // 룸 선택
    await page.evaluate((room) => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
            if (el.children.length === 0 && el.textContent.includes(room) && el.textContent.includes('스터디')) {
                el.click();
                return;
            }
        }
    }, ROOM);
    log(`✅ ${ROOM} 룸 탭 클릭`);
    await delay(1500);
    
    // 시간 선택
    const stNo = ROOM_ID[ROOM];
    if (!stNo) throw new Error(`ROOM_ID 매핑 없음: ROOM=${ROOM}`);

    // 날짜 변경 직후 스케줄 표가 갱신될 때까지 대기 (li[date=DATE]가 보일 때까지)
    log(`⏳ 스케줄 갱신 대기중... (date=${DATE}, st_no=${stNo})`);
    let scheduleReady = false;
    for (let i = 0; i < 20; i++) {
      scheduleReady = await page.evaluate((dateStr, stNoStr) => {
        return !!document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
      }, DATE, stNo);
      if (scheduleReady) break;
      await delay(250);
    }
    log(scheduleReady ? '✅ 스케줄 갱신 감지' : '⚠️ 스케줄 갱신 감지 실패(그래도 시간 선택 시도)');

    // ✅ (요청 #1) 예약화면에서 시간표 영역이 아래에 있을 수 있으니 스크롤
    try {
      const scrolled = await page.evaluate((dateStr, stNoStr) => {
        const el = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      }, DATE, stNo);
      log(scrolled ? '🖱️ 시간표 영역으로 스크롤 완료' : '⚠️ 스크롤 대상 시간표(li)를 못 찾음');
    } catch (e) {
      log(`⚠️ 스크롤 실패: ${e.message}`);
    }
    await delay(300);

    // 원하는 시간이 이미 예약(used)일 수 있으니 30분 단위로 다음 슬롯까지 자동 탐색
    // ⚠️ 네이버 예약 연동 시에는 자동 탐색이 "다음 시간대" 중복 예약을 만들 수 있음
    // STRICT_TIME=1이면 요청 시간(START_TIME~END_TIME)만 시도하고, 막혀있으면 즉시 실패
    // END_TIME-START_TIME 만큼의 duration(분)을 유지해서 찾음
    const toMinutes = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const requestedDurationMin = (() => {
      const d = toMinutes(END_TIME) - toMinutes(START_TIME);
      return d > 0 ? d : 30;
    })();

    // DEV/OPS 룰: 기본은 strict(자동 폴백 금지)
    const strictTime = (process.env.STRICT_TIME || '1') === '1';
    const maxSlotsToTry = strictTime ? 1 : 24; // strict면 1회만, 아니면 최대 12시간(30분*24)
    let chosen = null;

    for (let i = 0; i < maxSlotsToTry; i++) {
      const s = addMinutesHHMM(START_TIME, i * 30);
      const e = addMinutesHHMM(s, requestedDurationMin);
      log(`⏰ 시간 선택 시도 #${i + 1}: ${s} -> ${e} (duration=${requestedDurationMin}m)`);

      const res = await page.evaluate((dateStr, stNoStr, start, end, durationMin) => {
        const startLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${start}"][mb_no=""]`);
        const endLi   = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${end}"][mb_no=""]`);

        const okStart = !!(startLi && !startLi.classList.contains('used'));
        const okEnd   = !!(endLi && !endLi.classList.contains('used'));

        // 1시간 이상이면 중간 슬롯이 모두 available인지도 확인 (30분 단위)
        let okMid = true;
        if (durationMin > 30) {
          const startMin = (() => {
            const [h, m] = start.split(':').map(Number);
            return h * 60 + m;
          })();
          for (let t = startMin; t < startMin + durationMin; t += 30) {
            const hh = String(Math.floor(t / 60)).padStart(2, '0');
            const mm = String(t % 60).padStart(2, '0');
            const li = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${hh}:${mm}"][mb_no=""]`);
            if (!(li && !li.classList.contains('used'))) {
              okMid = false;
              break;
            }
          }
        }

        const canClick = okStart && okEnd && okMid;
        if (canClick) {
          startLi.click();
          endLi.click();
        }

        return {
          startExists: !!startLi,
          endExists: !!endLi,
          startClicked: canClick,
          endClicked: canClick,
          okMid
        };
      }, DATE, stNo, s, e, requestedDurationMin);

      log(`   ↳ 결과: startExists=${res.startExists} startClicked=${res.startClicked} / endExists=${res.endExists} endClicked=${res.endClicked}`);

      if (res.startClicked && res.endClicked) {
        chosen = { start: s, end: e };
        break;
      }

      await delay(350);
    }

    if (!chosen) {
      throw new Error(`시간 선택 실패: 시작=${START_TIME}부터 ${maxSlotsToTry}개 슬롯까지 모두 실패`);
    }

    log(`✅ 최종 시간 선택 확정: ${chosen.start} -> ${chosen.end}`);

    await delay(2000);
    
    // ======================== 7단계: 저장 ========================
    log('\n[7단계] 저장');

    // ✅ 예외처리(안전장치): 시간/금액 계산이 깨진 상태면 저장 금지
    const sanity = await page.evaluate(() => {
      const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

      // ✅ 사장님 제공 HTML 기준 (정확한 셀렉터)
      const priceText = clean(document.querySelector('#study_price')?.innerText || document.querySelector('#study_price')?.textContent);

      const startDate = clean(document.querySelector('#start_date')?.value);
      const startTime = clean(document.querySelector('#start_time')?.value);
      const endDate = clean(document.querySelector('#end_date')?.value);
      const endTime = clean(document.querySelector('#end_time')?.value);

      const parseMoney = (s) => {
        if (!s) return null;
        const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : null;
      };

      const priceNum = parseMoney(priceText);

      const badAmount = (typeof priceText === 'string' && priceText.includes('-')) || (priceNum !== null && priceNum < 0);

      // 시간 확정 여부: start_time/end_time이 비어있으면 저장 금지
      const missingTime = !startTime || !endTime;

      // 이용시간(분) 계산 (end_date/time까지 있으면 계산, 없으면 null)
      const toTs = (d, t) => {
        if (!d || !t) return null;
        const ms = Date.parse(`${d}T${t}:00`);
        return Number.isFinite(ms) ? ms : null;
      };

      const ts1 = toTs(startDate, startTime);
      const ts2 = toTs(endDate || startDate, endTime); // end_date 비어있으면 start_date 사용

      let durationMin = null;
      if (ts1 !== null && ts2 !== null) {
        durationMin = Math.round((ts2 - ts1) / 60000);
      }

      const badTime = missingTime || (durationMin !== null && durationMin <= 0);

      return {
        startDate, startTime, endDate, endTime,
        durationMin,
        priceText, priceNum,
        badTime, badAmount,
        extracted: { hasPrice: !!priceText }
      };
    });

    log(`🧪 저장 전 검증: ${JSON.stringify(sanity)}`);

    if (sanity.badTime || sanity.badAmount) {
      throw new Error(
        `저장 중단: 시간/금액 비정상 (start=${sanity.startDate} ${sanity.startTime}, end=${sanity.endDate || sanity.startDate} ${sanity.endTime}, durationMin=${sanity.durationMin}, price=${sanity.priceText})`
      );
    }

    if (!sanity.extracted?.hasPrice) {
      log('⚠️ 저장 전 검증: #study_price를 찾지 못했습니다. (그래도 음수/시간검증은 통과)');
    }

    log('💾 "작성하기" 버튼 클릭...');
    try {
        await page.click('input[type="submit"][value="작성하기"]');
        log('✅ 작성하기 클릭 완료');
    } catch (e) {
        throw new Error(`작성하기 버튼 클릭 실패: ${e.message}`);
    }

    // 등록 완료 alert("등록되었습니다.") 등 팝업 처리 시간 확보
    // (이 단계에서 브라우저를 닫으면 결제 모달로 못 넘어감)
    await delay(1500);

    // ======================== 8단계: 결제(확정) ========================
    log('\n[8단계] 결제(확정) 처리');

    // 8-1) 상세 화면의 "결제하기" 버튼 클릭
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
    log(payBtnClicked ? '✅ 상세 화면 결제하기 클릭' : '⚠️ 상세 화면 결제하기 버튼을 못 찾음(화면/셀렉터 확인 필요)');

    await delay(1200);

    // 8-2) 결제 모달에서 입력값 세팅 (사장님 정의 로직)
    // 1) 상단 결제금액 0 입력
    // 2) 주문메모 "네이버예약 결제" 입력
    // 3) 현금 마우스 클릭
    // 4) 총 결제금액 0 체크(깜빡임/원복 대비 폴링)
    // 5) 결제하기 클릭(8-3)

    const norm = (s) => (s ?? '').replace(/[\s,]/g, '').trim();

    const setTopPriceZero = async () => {
      const priceInp = await page.$('#od_add_item_price');
      if (!priceInp) return false;

      await priceInp.click({ clickCount: 3 });
      await delay(120);
      // 전체선택(맥/윈도우 둘 다 시도)
      try { await page.keyboard.press('Meta+A'); } catch (e) {}
      try { await page.keyboard.press('Control+A'); } catch (e) {}
      await delay(80);
      // 확실히 삭제
      for (let k = 0; k < 8; k++) {
        await page.keyboard.press('Backspace');
        await delay(40);
      }
      await delay(80);
      await page.keyboard.type('0', { delay: 80 });
      await delay(150);
      // blur: 모달 빈 곳 클릭 (Tab은 깜빡임 유발 가능)
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
      // 최대 ~3초 동안 0이 되는지 + 2연속 유지 확인
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

    // ---- 실행 (깜빡임/원복 대비 2회까지 재시도) ----
    let cashOk = false;
    let priceOk = false;
    let memoOk = false;
    let totalText = '';

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

    const payModalResult = {
      cashOk,
      priceOk,
      memoOk,
      totalText,
      note: '결제 사유(od_add_item_dsc)는 자동 고정'
    };

    log(`🧾 결제 모달 입력 결과: ${JSON.stringify(payModalResult)}`);

    if (norm(payModalResult.totalText) !== '0') {
      throw new Error(`결제 중단: 총 결제금액이 0이 아님 (od_total_price3=${payModalResult.totalText})`);
    }

    await delay(300);

    // 8-3) 모달 하단 "결제하기" 버튼 클릭 (깜빡임/원복 대비)
    // - #pay_order 를 정확히 클릭
    // - 클릭 직전에 다시 한번 0원 세팅(원복 방지)
    // - 클릭 후 모달이 닫히거나 총액 0 유지되는지 확인
    
    const preClickReassertZero = async () => {
      // 사람이 수동으로 0 넣을 때 바뀌는 속성(price/ea)도 같이 맞춰줌
      try {
        await page.$eval('#od_add_item_price', (inp) => {
          inp.setAttribute('price', '0');
          inp.setAttribute('ea', '0');
        });
      } catch (e) {}

      // 총액 계산에 관여하는 hidden 값들도 0으로
      try {
        await page.$eval('#od_total_price', (inp) => { inp.value = '0'; });
      } catch (e) {}

      // 마지막으로 실제 입력도 한번 더 (원복 직전 방어)
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
        // 결제 모달 컨테이너(id=order_write)가 사라지면 닫힌 것으로 간주
        return !document.querySelector('#order_write');
      });
    };

    let paySubmitClicked = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`🧾 결제하기 클릭 시도 #${attempt}`);
      await preClickReassertZero();

      try {
        paySubmitClicked = await clickPayOrderMouse();
      } catch (e) {
        log(`⚠️ 결제하기 클릭 실패: ${e.message}`);
        paySubmitClicked = false;
      }

      await delay(600);

      // 클릭 후 상태 체크
      const closed = await modalClosed();
      const after = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
      log(`🔍 클릭 후 상태: modalClosed=${closed}, od_total_price3=${after}`);

      if (closed) break;
      if (norm(after) === '0') break;

      log('⚠️ 결제 클릭 후 총액이 원복된 것으로 보임. 0 재입력 후 재시도합니다...');
      await delay(400);
    }

    log(paySubmitClicked ? '✅ 모달 결제하기 클릭' : '⚠️ 모달 결제하기 버튼 클릭 실패');

    await delay(1200);

    log('\n✅ 완료! (등록+확정(결제) 처리까지 완료)');
    
    // ======================== 9단계: 완료 검증 ========================
    log('\n[9단계] 픽코 예약등록 + 결제 완료 검증');
    
    // 최종 상태 확인: 예약이 실제로 완료되었는지 픽코에서 조회
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
    
    // 성공 판정: alert("등록되었습니다.") + 결제 모달 닫힘 + 오류 없음
    const isSuccess = !finalStatus.hasErrorMsg && (finalStatus.hasSuccessMsg || paySubmitClicked);
    
    if (isSuccess) {
      log(`✅ [SUCCESS] 픽코 예약등록 + 결제 완료됨!`);
      log(`📅 예약정보: ${PHONE_NOHYPHEN} / ${DATE} / ${chosen.start}~${chosen.end} / ${ROOM}`);
      log(`💳 결제: ${payModalResult.totalText}원 (0원 현금결제)`);
    } else {
      log(`⚠️ [WARNING] 완료 상태 불명확 (수동 확인 필요)`);
    }

    // ✅ 성공 시 브라우저 처리
    // - DEV 모드: 기본 유지(사장님 확인 절차)
    // - OPS 모드: 기본 종료(자동화 안정)
    const hold = (process.env.HOLD_BROWSER === '1') || (MODE === 'dev');

    if (hold) {
      log(`🔍 브라우저 유지 (MODE=${MODE}, HOLD_BROWSER=${process.env.HOLD_BROWSER || ''}) → 사장님 확인용`);
      await delay(300_000);
    } else {
      log(`🧹 성공 처리 → 브라우저 종료 (MODE=${MODE})`);
      try { await browser.close(); } catch (e) {}
    }

  } catch (err) {
    log(`❌ 에러: ${err.message}`);
    // 디버깅을 위해 에러 시 브라우저는 기본 유지
    // HOLD_BROWSER_ON_ERROR=0 이면 에러 시에도 닫음
    if (process.env.HOLD_BROWSER_ON_ERROR === '0') {
      log('🧹 HOLD_BROWSER_ON_ERROR=0 → 에러여도 브라우저 종료');
      try { await browser.close(); } catch (e) {}
    } else {
      log('🛑 에러 발생: 브라우저를 닫지 않고 대기합니다. (직접 화면 확인 후 알려주세요)');
      await delay(600_000);
    }
  }
}

main().catch(err => {
  console.error('Main 실행 중 예외:', err);
  // 어떤 이유로든 최상위 에러면 브라우저를 닫지 않음
  process.exit(1);
});
