#!/usr/bin/env node

/**
 * 네이버 스마트플레이스 예약현황 모니터링 (Puppeteer 기반)
 * 5분 주기로 예약 현황 모니터링
 * 변경사항 감지 시 스크린샷 및 알림
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 설정
const NAVER_ID = 'blockchainmaster';
const NAVER_PW = 'LEEjr03311030!';
// ✅ 홈(검은 예약현황 박스)로 바로 가는 URL
const NAVER_URL = 'https://new.smartplace.naver.com/bizes/place/3990161';
const MODE = (process.env.MODE || 'dev').toLowerCase();
// ⚠️ 변경/신규 프로세스 감지 시 자동으로 DEV 정책을 적용(픽코 실행 차단)
const SAFE_DEV_FALLBACK = (process.env.SAFE_DEV_FALLBACK || '1') === '1';
const MONITOR_INTERVAL = parseInt(process.env.NAVER_INTERVAL_MS || (MODE === 'ops' ? '300000' : '120000'), 10); // ops=5분, dev=2분 기본
const MONITOR_DURATION = 2 * 60 * 60 * 1000; // 2시간

// 유틸
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 이전 상태
let previousState = {
  '오늘 확정': null,
  '오늘 이용': null,
  '오늘 취소': null
};

// 로그 함수
function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

// ✅ 시간 처리: "오전 12:00~오후 1:00" → { start: "00:00", end: "13:00" }
function parseTimeText(timeText) {
  // 예: "오전 11:00~오후 12:00" → { period1: "오전", hour1: 11, min1: 0, period2: "오후", hour2: 12, min2: 0 }
  if (!timeText) return null;

  // 정규식: "오전/오후 H:MM~오전/오후 H:MM"
  const pattern = /(오전|오후)\s+(\d{1,2}):(\d{2})~(오전|오후)?\s*(\d{1,2}):(\d{2})/;
  const match = timeText.match(pattern);
  
  if (!match) return null;

  let period1 = match[1]; // "오전" 또는 "오후"
  let hour1 = parseInt(match[2]);
  let min1 = parseInt(match[3]);
  let period2 = match[4] || period1; // 생략되면 period1 따라가기
  let hour2 = parseInt(match[5]);
  let min2 = parseInt(match[6]);

  // 24시간 변환
  const convertTo24 = (hour, period) => {
    if (period.includes('오전')) {
      return hour === 12 ? 0 : hour; // 오전 12:00 → 00:00
    } else {
      return hour === 12 ? 12 : hour + 12; // 오후 12:00 → 12:00, 오후 1:00 → 13:00
    }
  };

  const start24 = convertTo24(hour1, period1);
  const end24 = convertTo24(hour2, period2);

  return {
    start: `${String(start24).padStart(2, '0')}:${String(min1).padStart(2, '0')}`,
    end: `${String(end24).padStart(2, '0')}:${String(min2).padStart(2, '0')}`
  };
}

// ✅ 팝업 자동 감지 및 클릭 (루프로 모든 팝업 처리)
async function closePopupsIfPresent(page) {
  try {
    // 페이지가 유효한지 확인
    if (!page || page.isClosed?.() === true) {
      return;
    }

    // 팝업이 없을 때까지 루프 실행
    let popupCount = 0;
    const maxLoops = 10; // 무한 루프 방지

    for (let loop = 0; loop < maxLoops; loop++) {
      try {
        const popupHandled = await page.evaluate(() => {
          let handled = false;

          // 1️⃣ 일주일 동안 보지 않기 체크박스 찾기 및 체크
          const checkbox = document.querySelector('input#checkShow');
          if (checkbox && !checkbox.checked) {
            const isVisible = checkbox.offsetParent !== null;
            if (isVisible) {
              console.log(`✅ '일주일 동안 보지 않기' 체크박스 선택`);
              checkbox.click();
              handled = true;
            }
          }

          // 2️⃣ X 버튼 찾기 및 클릭 (class 또는 data-testid로 찾기)
          const closeBtn = document.querySelector('button.Popup_btn_close__YO5i8') 
                        || document.querySelector('button[data-testid="popup-close-btn"]');
          if (closeBtn) {
            const isVisible = closeBtn.offsetParent !== null;
            if (isVisible) {
              console.log(`🔘 X 버튼 클릭`);
              closeBtn.click();
              handled = true;
            }
          }

          return handled;
        }).catch(() => false);

        if (popupHandled) {
          popupCount++;
          log(`✅ 팝업 #${popupCount} 처리 완료 (일주일동안보지않기 + X 클릭)`);
          await delay(800); // 팝업 닫히는 시간 대기
        } else {
          // 팝업이 더 이상 없으면 루프 탈출
          if (loop > 0) {
            log(`✅ 모든 팝업 처리 완료 (총 ${popupCount}개)`);
          } else {
            log(`ℹ️ 팝업 없음 - 계속 진행`);
          }
          break;
        }
      } catch (evalErr) {
        // evaluate 중 프레임 손상 무시
        if (!String(evalErr).includes('detached')) {
          log(`⚠️ 팝업 감지 중 에러(무시): ${evalErr.message}`);
        }
        break;
      }
    }
  } catch (err) {
    log(`⚠️ 팝업 처리 실패: ${err.message}`);
  }
}

// 예약 현황 추출
async function getBookingStatus(page) {
  try {
    // ✅ 홈 화면의 "예약 현황" 섹션을 텍스트로 찾고, 그 내부에서 오늘 확정/이용/취소 숫자 파싱
    // (class 해시가 바뀌는 경우가 있어 클래스 의존도를 낮춤)
    await page.waitForFunction(() => {
      const t = (document.body && (document.body.innerText || document.body.textContent)) || '';
      return t.includes('예약 현황') && (t.includes('오늘 확정') || t.includes('오늘 이용') || t.includes('오늘 취소'));
    }, { timeout: 30000 });

    const bookingData = await page.evaluate(() => {
      const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
      const data = { '오늘 확정': 0, '오늘 이용': 0, '오늘 취소': 0 };

      // "예약 현황" 제목을 가진 섹션을 찾고, 가장 가까운 컨테이너에서 링크를 읽는다.
      const h3 = Array.from(document.querySelectorAll('h3')).find(h => (h.textContent || '').includes('예약 현황'));
      if (!h3) return data;

      // 상위로 올라가며 a 태그가 있는 영역을 찾기
      let root = h3.closest('div');
      for (let i = 0; i < 6 && root; i++) {
        const anchors = root.querySelectorAll('a');
        if (anchors && anchors.length >= 2) break;
        root = root.parentElement;
      }
      root = root || document.body;

      const anchors = Array.from(root.querySelectorAll('a'))
        .filter(a => {
          const t = clean(a.textContent);
          return t.includes('오늘 확정') || t.includes('오늘 이용') || t.includes('오늘 취소');
        });

      for (const a of anchors) {
        const t = clean(a.textContent);
        // 우선 strong 숫자 우선
        const strong = a.querySelector('strong');
        const numText = strong ? clean(strong.textContent) : (t.match(/(\d+)/)?.[1] || '0');
        const num = parseInt(String(numText).replace(/\D/g, ''), 10);

        if (t.includes('오늘 확정')) data['오늘 확정'] = Number.isNaN(num) ? 0 : num;
        if (t.includes('오늘 이용')) data['오늘 이용'] = Number.isNaN(num) ? 0 : num;
        if (t.includes('오늘 취소')) data['오늘 취소'] = Number.isNaN(num) ? 0 : num;
      }

      return data;
    });

    return bookingData;
  } catch (err) {
    log(`⚠️ 예약 현황 추출 실패: ${err.message}`);
    return null;
  }
}

// 캘린더(예약/주문) 화면이면 "홈화면 이동"으로 복귀
async function ensureHomeFromCalendar(page) {
  // ✅ 메뉴 클릭 대신 URL로 홈 화면 강제 복귀
  // ⚠️ Fix: NAVER_URL이 prefix이므로 booking-list-view 등의 하위 경로도 startsWith로 통과됨
  //         → 하위 경로 키워드를 명시적으로 감지하여 복귀 처리
  try {
    const url = page.url();
    const isSubPage = [
      'booking-list-view',
      'booking-calendar-view',
      'booking-order-view',
      'booking-detail',
    ].some((kw) => url.includes(kw));

    if (!isSubPage && url.startsWith(NAVER_URL)) return; // 이미 홈

    log(`↩️ 홈 URL로 복귀 (현재: ${url})`);
    await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
  } catch (e) {
    log(`⚠️ 홈 URL 복귀 실패(무시): ${e.message}`);
  }
}

// 네이버 로그인
async function naverLogin(page) {
  try {
    log('🔐 네이버 로그인 시작...');

    await page.goto(NAVER_URL, { waitUntil: 'networkidle2' });

    // 홈 예약현황(오늘 확정/이용/취소) 링크가 보이면 로그인 완료로 판단 (클래스 해시 변동 대응)
    const homeReady = await page.evaluate(() => {
      const t = (document.body && (document.body.innerText || document.body.textContent)) || '';
      return t.includes('오늘 확정') || t.includes('예약 현황');
    });
    if (homeReady) {
      log('✅ 이미 로그인 상태(홈 예약현황 감지)');
      return true;
    }

    // ✅ 3단계 전: 팝업 확인 및 클릭 (로그인 폼 감지 전)
    log('🔍 팝업 확인 중...');
    const popupClicked = await page.evaluate(() => {
      let clicked = false;
      
      // 보이는 모든 버튼 찾기
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const isVisible = btn.offsetParent !== null;
        
        // 확인, OK, 닫기 등의 버튼 찾기
        if (isVisible && (text === '확인' || text === 'OK' || text === '닫기' || text === '완료' || text === '네' || text === 'Yes')) {
          console.log(`🔘 팝업 버튼 감지 및 클릭: "${text}"`);
          btn.click();
          clicked = true;
          break;
        }
      }
      
      return clicked;
    });
    
    if (popupClicked) {
      log('✅ 팝업 감지 및 클릭 완료');
      await delay(1500); // 팝업 닫히는 시간 대기
    } else {
      log('ℹ️ 팝업 없음 - 계속 진행');
    }

    // 로그인 폼 감지
    const hasLoginForm = await page.$('input#id, input[name="id"], input#pw, input[name="pw"]');
    if (hasLoginForm) {
      // 2단계 보안이 켜져 있으면 headless에서 막힐 수 있음 → 창을 띄우고 사장님이 1회 수동 로그인
      const isHeadless = process.env.NAVER_HEADLESS !== '0';
      if (isHeadless) {
        log('⚠️ 로그인 폼 감지: 현재 headless 모드입니다. 2단계 보안이 있으면 실패할 수 있어요. NAVER_HEADLESS=0으로 재실행 권장');
      }

      log('로그인 필요 - 아이디/비밀번호 입력 시도');

      await page.waitForSelector('input#id, input[name="id"]', { timeout: 10000 });
      const idSel = (await page.$('input#id')) ? 'input#id' : 'input[name="id"]';
      const pwSel = (await page.$('input#pw')) ? 'input#pw' : 'input[name="pw"]';

      await page.click(idSel, { clickCount: 3 });
      await page.type(idSel, NAVER_ID, { delay: 30 });
      await page.click(pwSel, { clickCount: 3 });
      await page.type(pwSel, NAVER_PW, { delay: 30 });

      // 로그인 버튼
      const loginBtnSel = (await page.$('button#log\.login')) ? 'button#log\.login'
        : (await page.$('button[type="submit"]')) ? 'button[type="submit"]'
        : null;

      if (loginBtnSel) {
        await page.click(loginBtnSel);
      } else {
        await page.keyboard.press('Enter');
      }

      // ✅ 2단계 인증/추가 동작을 사장님이 처리할 시간
      log('⏳ (필요시) IP보안/2단계 화면을 완료해주세요. 완료되면 업체 대시보드(오늘 확정)가 보입니다. 최대 10분 대기');
      
      // waitForFunction 내에서 팝업 자동 감지 및 클릭
      await page.waitForFunction(() => {
        // 팝업 자동 클릭
        try {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '확인' || text === 'OK' || text === 'Yes' || text === '네') {
              const isVisible = btn.offsetParent !== null;
              if (isVisible) {
                btn.click();
                break;
              }
            }
          }
        } catch (e) {
          // 무시
        }

        // 오늘 확정이 보이면 대기 종료
        const t = (document.body && (document.body.innerText || document.body.textContent)) || '';
        return t.includes('오늘 확정') || t.includes('예약 현황');
      }, { timeout: 10 * 60 * 1000 }).catch(() => null);

      // 로그인 후 홈으로 이동(리다이렉트 실패 대비)
      await page.goto(NAVER_URL, { waitUntil: 'networkidle2' });
    } else {
      log('⚠️ 로그인 폼을 못 찾음(추가 인증/차단 가능).');
    }

    // 홈/업체선택 화면 처리
    // 1) 업체 카드("커피랑도서관 분당서현점")가 보이면 클릭
    // 2) "오늘 확정" 카드가 보일 때까지 대기

    const clickMyBizIfPresent = async () => {
      // 업체 카드 링크(텍스트 기반)
      const clicked = await page.evaluate(() => {
        const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
        const targetText = '커피랑도서관 분당서현점';
        const as = Array.from(document.querySelectorAll('a'));
        for (const a of as) {
          const t = clean(a.textContent);
          if (t.includes(targetText)) {
            a.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        log('🏪 내 업체(커피랑도서관 분당서현점) 카드 클릭');
        // SPA일 수 있어 navigation 대신 네트워크 안정/대기
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
      }
      return clicked;
    };

    const waitTodayCards = async (timeoutMs) => {
      await page.waitForFunction(() => {
        const t = (document.body && (document.body.innerText || document.body.textContent)) || '';
        return t.includes('오늘 확정') || t.includes('예약 현황');
      }, { timeout: timeoutMs });
    };

    // 2단계 보안/추가 확인이 있으면 사용자가 처리할 시간을 줌
    try {
      await clickMyBizIfPresent();
      await waitTodayCards(30000);
    } catch (e) {
      log('⏳ 추가 확인 단계/업체 선택 대기: 브라우저에서 안내대로 진행해주세요.');
      log('   완료되면 자동으로 업체 카드 클릭/오늘 확정 감지를 재시도합니다.');

      // 최대 10분까지 반복 대기
      const start = Date.now();
      while (Date.now() - start < 10 * 60 * 1000) {
        await clickMyBizIfPresent();
        try {
          await waitTodayCards(5000);
          break;
        } catch (e2) {
          await delay(1000);
        }
      }

      // 최종 확인
      await waitTodayCards(20000);
    }

    log('✅ 페이지 로드 완료(오늘 확정 카드 감지)');
    return true;
  } catch (err) {
    log(`❌ 로그인/페이지 로드 실패: ${err.message}`);
    return false;
  }
}

// 스크린샷 저장
async function takeScreenshot(page, reason) {
  try {
    const timestamp = new Date().toLocaleString('ko-KR', { 
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      date: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(/[:\s]/g, '-');
    
    const filename = path.join('/Users/alexlee/.openclaw/workspace', `booking-${timestamp}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    log(`📸 스크린샷 저장: ${filename}`);
    return filename;
  } catch (err) {
    log(`❌ 스크린샷 실패: ${err.message}`);
    return null;
  }
}

// 변경사항 감지
function detectChanges(current) {
  const changes = [];
  
  for (const key of Object.keys(previousState)) {
    if (previousState[key] !== null && previousState[key] !== current[key]) {
      changes.push({
        name: key,
        from: previousState[key],
        to: current[key]
      });
    }
  }
  
  return changes;
}

// 알림 메시지 전송
async function sendNotification(message) {
  try {
    // Telegram 메시지 전송 (OpenClaw 메시지 시스템)
    const axios = require('axios');
    
    log(`📢 알림: ${message}`);
    
    // 파일에 기록
    const logFile = path.join('/Users/alexlee/.openclaw/workspace', 'monitor-log.txt');
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (err) {
    log(`⚠️ 알림 전송 실패: ${err.message}`);
  }
}

// 메인 모니터링 함수
async function monitorBookings() {
  // ✅ 단일 인스턴스 락(관찰 OPS에서 중복 실행 방지)
  const LOCK_FILE = path.join('/Users/alexlee/.openclaw/workspace', 'naver-monitor.lock');
  let lockFd = null;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) {
    log(`🛑 이미 실행 중입니다(락 존재): ${LOCK_FILE}`);
    return;
  }

  let browser;
  const startTime = Date.now();
  let checkCount = 0;

  try {
    log('🚀 네이버 예약 모니터링 시작 (2시간)');
    
    // Puppeteer 실행
    // ✅ 네이버 2단계 보안(추가인증) 때문에 최초 1회는 headless=false + userDataDir로 세션 저장 권장
    browser = await puppeteer.launch({
      headless: false, // 🖥️ 항상 브라우저 화면 표시
      userDataDir: path.join('/Users/alexlee/.openclaw/workspace', 'naver-profile'),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-position=0,0', // 📍 메인 화면 좌상단에 고정 (Mac)
        '--window-size=1920,1080', // 📺 전체 화면 크기
        '--start-fullscreen', // 📺 전체화면 모드
        // ✅ 백그라운드/탭 회수(페이지 확보)로 인한 frame detach 완화
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TabDiscarding,Translate,BackForwardCache'
      ]
    });
    
    const isHeadless = process.env.NAVER_HEADLESS !== '0';

    // ✅ 탭 분리(Headful일 때만): 사장님 탭을 건드리지 않기 위함
    let pageMain = null;
    let page = null;

    if (!isHeadless) {
      pageMain = await browser.newPage();
      page = await browser.newPage();

      await pageMain.setViewport({ width: 1920, height: 1080 });
      await page.setViewport({ width: 1920, height: 1080 });

      await pageMain.goto(NAVER_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
      log('🧷 메인 탭(pageMain) 고정: 이 탭은 건드리지 않습니다. (자동화는 다른 탭에서 진행)');
    } else {
      // headless는 탭/팝업 이슈가 적으므로 단일 탭으로 운영
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      log('🫥 Headless 모드: 단일 탭으로 모니터링 진행');
    }

    const loggedIn = await naverLogin(page);
    if (!loggedIn) {
      log('❌ 로그인 실패로 종료');
      return;
    }
    
    // 모니터링 루프
    while (Date.now() - startTime < MONITOR_DURATION) {
      checkCount++;
      
      try {
        // 매 회차 작업 탭을 홈으로 유도
        await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
        await ensureHomeFromCalendar(page);
        
        log(`\n📍 확인 #${checkCount}`);

        // ✅ 검은 박스(예약 현황) 리프레시 버튼 클릭 후 딜레이
        try {
          const refreshBtn = await page.$('button.Home_btn_refresh__9AS9P');
          if (refreshBtn) {
            const box = await refreshBtn.boundingBox();
            if (box) {
              const x = box.x + box.width / 2;
              const y = box.y + box.height / 2;
              log(`🖱️ 예약현황 새로고침 클릭 (x=${Math.round(x)}, y=${Math.round(y)})`);
              // 시각적으로 보이게: 더블클릭 + 짧은 딜레이
              await page.mouse.click(x, y);
              await delay(80);
              await page.mouse.click(x, y);

              const ms = parseInt(process.env.NAVER_REFRESH_DELAY_MS || '1200', 10);
              log(`⏱️ 새로고침 대기 ${ms}ms`);
              await delay(ms);
            }
          }
        } catch (e) {
          log(`⚠️ 새로고침 클릭 실패(무시): ${e.message}`);
        }
        
        // 팝업 감지 및 자동 클릭 (모니터링 주기마다)
        await closePopupsIfPresent(page);
        
        // 예약 현황 추출
        const currentState = await getBookingStatus(page);
        log(`🧾 (RAW) 상태 JSON: ${JSON.stringify(currentState)}`);
        
        if (!currentState || Object.keys(currentState).length === 0) {
          log('⚠️ 예약 현황 데이터 추출 실패');
          await new Promise(resolve => setTimeout(resolve, MONITOR_INTERVAL));
          continue;
        }
        
        // 현재 상태 출력
        log(`📊 현재: 확정=${currentState['오늘 확정'] || 0}, 이용=${currentState['오늘 이용'] || 0}, 취소=${currentState['오늘 취소'] || 0}`);
        
        // ✅ 오늘 확정이 있으면 항상 리스트 파싱은 수행
        // - PICKKO_ENABLE=1 일 때만 픽코까지 실행
        if ((currentState['오늘 확정'] || 0) > 0) {
          try {
            log('🧩 오늘 확정 리스트 파싱 시도...');

            // 홈의 "오늘 확정" 카드 href로 직접 이동 (click/navigation 불안정 회피)
            let confirmedHref = await page.evaluate(() => {
              const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
              const links = Array.from(document.querySelectorAll('a'));
              const a = links.find(x => clean(x.textContent).includes('오늘 확정') && String(x.href || '').includes('booking-list-view'));
              return a ? a.href : null;
            });
            // ⚠️ Fix: href를 못 찾으면 URL을 직접 구성해서 폴백
            if (!confirmedHref) {
              const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })
                .replace(/\./g, '').replace(/\s/g, '-').split('-').filter(Boolean)
                .map((v, i) => i === 0 ? v : v.padStart(2, '0')).join('-');
              const bizId = NAVER_URL.match(/\/place\/(\d+)/)?.[1] || NAVER_URL.split('/').filter(Boolean).pop();
              confirmedHref = `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CONFIRMED&date=${today}`;
              log(`⚠️ 오늘 확정 링크 자동 탐색 실패 → URL 직접 구성: ${confirmedHref}`);
            }

            log(`🔗 오늘 확정 리스트 이동: ${confirmedHref}`);
            await page.goto(confirmedHref, { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => null);
            await delay(500); // 추가 렌더링 대기

            // 5단계: 팝업 체크 및 처리 (일주일동안보지않기 + X 클릭)
            log('🔍 5단계 팝업 확인 중...');
            try {
              const popupHandled = await page.evaluate(() => {
                let handled = false;

                // 1️⃣ '일주일동안보지않기' 체크박스 찾기
                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                for (const checkbox of checkboxes) {
                  const label = checkbox.closest('label') || checkbox.parentElement;
                  const labelText = (label?.textContent || '').trim();
                  
                  if (labelText.includes('일주일') || labelText.includes('보지않기')) {
                    // 보이는 체크박스만 클릭
                    const isVisible = checkbox.offsetParent !== null;
                    if (isVisible && !checkbox.checked) {
                      console.log(`✅ '일주일동안보지않기' 체크박스 선택`);
                      checkbox.click();
                      handled = true;
                    }
                    break;
                  }
                }

                // 2️⃣ X 버튼 찾기 및 클릭 (닫기 버튼)
                const closeButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                for (const btn of closeButtons) {
                  const isClose = btn.getAttribute('aria-label')?.includes('닫기') 
                    || btn.textContent.trim() === '✕'
                    || btn.textContent.trim() === 'X'
                    || btn.className.includes('close')
                    || btn.className.includes('Close');
                  
                  const isVisible = btn.offsetParent !== null;
                  if (isClose && isVisible) {
                    console.log(`🔘 X 버튼 클릭`);
                    btn.click();
                    handled = true;
                    break;
                  }
                }

                return handled;
              }).catch(() => false);

              if (popupHandled) {
                log('✅ 5단계 팝업 처리 완료 (일주일동안보지않기 + X 클릭)');
                await delay(1000); // 팝업 닫히는 시간 대기
              } else {
                log('ℹ️ 5단계 팝업 없음 - 계속 진행');
              }
            } catch (popupErr) {
              log(`⚠️ 5단계 팝업 처리 중 에러: ${popupErr.message}`);
            }

            log(`🌐 현재 URL: ${page.url()}`);
            await page.waitForSelector('a[data-tst_click_link], [class*="nodata-area"], [class*="nodata"], .nodata', { timeout: 30000 });
            
            // ✅ 요소가 실제로 렌더링될 때까지 대기 (Detached Frame 방지)
            await page.waitForFunction(() => {
              const rows = document.querySelectorAll('a[data-tst_click_link]');
              const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
              return rows.length > 0 || noData;
            }, { timeout: 30000 });

            await delay(800); // 최종 렌더링 대기

            // ✅ 렌더링 완료 검증: 실제 예약 데이터가 로드되었는지 확인
            log('🔍 렌더링 상태 점검 중...');
            const pageState = await page.evaluate(() => {
              // 1. nodata 확인
              const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
              
              // 2. 다양한 선택자로 예약 항목 찾기
              const byDataAttr = document.querySelectorAll('a[data-tst_click_link]');
              const byRole = document.querySelectorAll('[role="row"], [role="listitem"]');
              const allAnchors = document.querySelectorAll('a');
              
              // 3. 페이지 텍스트에서 예약 정보 감지
              const pageText = (document.body?.innerText || '').slice(0, 500);
              const hasPhonePattern = /010-?\d{4}-?\d{4}/.test(pageText);
              const hasTimePattern = /(\d{1,2}):(\d{2})/.test(pageText);
              const hasRoomPattern = /\b(A1|A2|B)\b/.test(pageText);
              
              return {
                noDataPresent: !!noData,
                noDataVisible: noData?.offsetParent !== null,
                dataAttrCount: byDataAttr.length,
                roleRowCount: byRole.length,
                totalAnchors: allAnchors.length,
                pageHasPhone: hasPhonePattern,
                pageHasTime: hasTimePattern,
                pageHasRoom: hasRoomPattern,
                pageTextSample: pageText
              };
            });
            
            log(`🔍 페이지 상태: ${JSON.stringify(pageState)}`);
            
            if (pageState.noDataPresent && pageState.noDataVisible) {
              log('ℹ️ 오늘 확정 예약 없음 (nodata 영역 감지)');
            }

            const newest = await scrapeNewestBookingsFromList(page, 8);
            log(`🧾 리스트 파싱 결과(상위): ${JSON.stringify(newest.slice(0, 3))}`);
            
            // ✅ 디버그: 파싱 결과가 비어있으면 상세 분석
            if (newest.length === 0 || newest.every(b => !b.phone)) {
              const dbg = await page.evaluate(() => {
                const allLinks = document.querySelectorAll('a[data-tst_click_link]');
                const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
                const matchingRows = Array.from(allLinks).slice(0, 3).map(a => ({
                  href: a.href,
                  text: a.textContent.slice(0, 100),
                  dataAttr: a.getAttribute('data-tst_click_link'),
                  phone: a.querySelector('[class*="phone"]')?.textContent || 'null',
                  time: a.querySelector('[class*="date"], [class*="time"]')?.textContent || 'null'
                }));
                return { 
                  totalLinks: allLinks.length, 
                  noDataPresent: !!noData,
                  samples: matchingRows 
                };
              });
              log(`🔍 디버그 - 상세 분석: ${JSON.stringify(dbg)}`);
            }
            if (newest.length === 0) {
              const dbg = await page.evaluate(() => {
                const noData = !!document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
                const rowCount = document.querySelectorAll('a[data-tst_click_link]').length;
                const text = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\s+/g, ' ').trim();
                return { noData, rowCount, textHead: text.slice(0, 200) };
              });
              log(`🧪 리스트 디버그: ${JSON.stringify(dbg)}`);
            }

            const seen = loadSeen();
            const seenSet = new Set(seen.seenIds || []);
            const toKey = (b) => b.bookingId || `${b.date}|${b.start}|${b.end}|${b.room}|${b.phone}`;

            const candidates = newest
              // date가 row에 없으면(드물게) 서울 기준 오늘로 채움
              .map(b => ({ ...b, date: b.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }) }))
              .filter(b => b.phone && b.date && b.start && b.end && b.room)
              .map(b => ({ ...b, _key: toKey(b) }))
              .filter(b => !seenSet.has(b._key));

            if (candidates.length === 0) {
              log('ℹ️ 신규 후보 없음(이미 처리했거나 파싱 실패)');
            } else {
              log(`✅ 신규 후보 ${candidates.length}건 발견.`);

              // ✅ 모드에 따른 기본 동작
              // dev: 픽코 실행 기본 OFF
              // ops: PICKKO_ENABLE=1일 때만 실행
              // ✅ 실행 조건
              // - DEV: DEV_PICKKO_TEST=1 이고, DEV_TEST_PHONE(기본 01035000586)만 픽코 실행 허용
              // - OPS: PICKKO_ENABLE=1 일 때만 픽코 실행
              const devTestPhone = (process.env.DEV_TEST_PHONE || '01035000586').replace(/\D/g, '');
              const allowDevPickko = (process.env.DEV_PICKKO_TEST === '1');

              if (MODE === 'dev') {
                if (!allowDevPickko) {
                  log(`🧷 MODE=dev, DEV_PICKKO_TEST!=1 → 픽코 실행은 건너뜁니다(파싱만 확인).`);
                  await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                  continue;
                }

                // DEV에서는 테스트 번호만 실행
                const onlyMine = candidates.filter(b => String(b.phone) === devTestPhone);
                if (onlyMine.length === 0) {
                  log(`🧷 MODE=dev: 테스트 번호(${devTestPhone}) 후보 없음 → 픽코 실행 안 함`);
                  await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                  continue;
                }

                log(`🧪 DEV 픽코 테스트: ${devTestPhone} 대상 ${onlyMine.length}건만 실행`);

                // DEV: 성공(code=0)일 때만 마킹 (실패면 재시도 가능)
                for (const b of onlyMine) {
                  const code = await runPickko(b);
                  if (code === 0) {
                    seenSet.add(b._key);
                    seen.seenIds = Array.from(seenSet).slice(-500);
                    saveSeen(seen);
                  } else {
                    log(`⚠️ DEV 픽코 실패(code=${code}) → seen 마킹 안 함(재시도 가능)`);
                  }
                }

                await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                continue;
              }

              // OPS
              // SAFE_DEV_FALLBACK=1이면, 파싱/시간 파트가 불완전하거나 리스크 이벤트 시 DEV 정책(픽코 차단)
              const riskItems = candidates.filter(b => !b.start || !b.end || !b.date);
              const risk = riskItems.length > 0;

              // 관찰 OPS: OBSERVE_PHONE(기본 사장님 번호)만 실행
              // 관찰 OPS: 테스트 번호 allowlist만 실행 (콤마로 여러 개 가능)
              // 예: OBSERVE_PHONES=01035000586,01054350586
              const observePhones = (process.env.OBSERVE_PHONES || process.env.OBSERVE_PHONE || '01035000586,01054350586')
                .split(',')
                .map(s => s.replace(/\D/g, ''))
                .filter(Boolean);
              const observeOnly = (process.env.OBSERVE_ONLY || '1') === '1';
              const observeFiltered = observeOnly ? candidates.filter(b => observePhones.includes(String(b.phone))) : candidates;

              if (observeOnly && observeFiltered.length === 0) {
                log(`👀 관찰 OPS: 대상 번호(${observePhones.join(',')}) 후보 없음 → 픽코 실행 안 함`);
                // 관찰 OPS에서는 다른 예약은 마킹하지 않음(운영 전환 시 처리 가능하게)
                await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                continue;
              }

              if ((SAFE_DEV_FALLBACK && risk) || process.env.PICKKO_ENABLE !== '1') {
                log(`🧷 MODE=ops, SAFE_DEV_FALLBACK=${SAFE_DEV_FALLBACK}, risk=${risk}, PICKKO_ENABLE=${process.env.PICKKO_ENABLE || ''} → 픽코 실행은 건너뜁니다(DEV 정책/파싱만 확인).`);

                if (SAFE_DEV_FALLBACK && risk) {
                  log('❓ [CONFIRM] 파싱이 불완전한 예약이 있어 OPS 실행을 보류합니다.');
                  for (const b of riskItems.slice(0, 3)) {
                    log(`   - bookingId=${b.bookingId} phone=${b.phone} date=${b.date} start=${b.start} end=${b.end} room=${b.room} timeText=${b.raw?.timeText || ''}`);
                  }
                }

                // ops에서는 재처리 방지를 위해 마킹
                for (const b of observeFiltered) seenSet.add(b._key);
                seen.seenIds = Array.from(seenSet).slice(-500);
                saveSeen(seen);

                await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                continue;
              }
              // OPS: 관찰 allowlist 필터를 적용하고, 성공(code=0)일 때만 seen 마킹
              for (const b of observeFiltered) {
                const code = await runPickko(b);
                if (code === 0) {
                  seenSet.add(b._key);
                  seen.seenIds = Array.from(seenSet).slice(-500);
                  saveSeen(seen);
                } else {
                  log(`⚠️ OPS 픽코 실패(code=${code}) → seen 마킹 안 함(재시도 가능)`);
                }
              }
            }

            await page.goto(NAVER_URL, { waitUntil: 'networkidle2' });
          } catch (e) {
            log(`⚠️ (상시) 오늘 확정 처리 실패: ${e.message}`);
            try { await page.goto(NAVER_URL, { waitUntil: 'networkidle2' }); } catch (e2) {}
          }
        }

        // 변경사항 감지
        const changes = detectChanges(currentState);
        
        if (changes.length > 0) {
          log('🔔 변경 감지!');
          
          for (const change of changes) {
            const message = `변경: ${change.name} (${change.from} → ${change.to})`;
            log(`   ⚠️ ${message}`);
            await sendNotification(message);
          }
          
          // 스크린샷 저장
          await takeScreenshot(page, 'booking-change');

          // ✅ 오늘 확정이 증가한 경우: (옵션) 신규 예약을 파싱해서 픽코로 확정 처리 시도
          const confirmedChange = changes.find(c => c.name === '오늘 확정' && c.to > c.from);
          if (process.env.PICKKO_ENABLE === '1' && confirmedChange) {
            try {
              log('🧩 신규 확정 예약 파싱 시도...');
              // 오늘 확정 리스트로 이동 (SPA 환경이라 click+navigation이 불안정 → href로 직접 이동)
              const links = await page.$$('a.Home_state_link__KzDE_');
              let clicked = false;
              for (const a of links) {
                const t = (await a.evaluate(el => (el.textContent || '').replace(/\s+/g, ' ').trim()));
                if (t.includes('오늘 확정')) {
                  const box = await a.boundingBox();
                  if (!box) continue;
                  const x = box.x + box.width / 2;
                  const y = box.y + box.height / 2;
                  log(`🖱️ 오늘 확정 카드 클릭 (x=${Math.round(x)}, y=${Math.round(y)})`);
                  await Promise.all([
                    page.mouse.click(x, y),
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
                  ]);
                  clicked = true;
                  break;
                }
              }

              if (!clicked) throw new Error('오늘 확정 링크를 찾지 못함(Home_state_link)');

              log(`🌐 현재 URL: ${page.url()}`);
              await page.waitForSelector('a[data-tst_click_link], [class*="nodata-area"], [class*="nodata"], .nodata', { timeout: 20000 });

              const newest = await scrapeNewestBookingsFromList(page, 8);
              log(`🧾 리스트 파싱 결과(상위): ${JSON.stringify(newest.slice(0, 3))}`);
              if (newest.length === 0) {
                const dbg = await page.evaluate(() => {
                  const noData = !!document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
                  const rowCount = document.querySelectorAll('a[data-tst_click_link]').length;
                  const text = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\s+/g, ' ').trim();
                  return { noData, rowCount, textHead: text.slice(0, 200) };
                });
                log(`🧪 리스트 디버그: ${JSON.stringify(dbg)}`);
              }

              // "오늘 확정" 링크가 TODAY이므로 date는 오늘(서울시간)로 주입
              const todaySeoul = (() => {
                const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
                return s;
              })();

              const seen = loadSeen();
              const seenSet = new Set(seen.seenIds || []);

              const toKey = (b) => b.bookingId || `${todaySeoul}|${b.start}|${b.end}|${b.room}|${b.phone}`;

              const candidates = newest
                .map(b => ({ ...b, date: todaySeoul }))
                .filter(b => b.phone && b.date && b.start && b.end && b.room)
                .map(b => ({ ...b, _key: toKey(b) }))
                .filter(b => !seenSet.has(b._key));

              if (candidates.length === 0) {
                log('ℹ️ 신규 후보 없음(이미 처리했거나 파싱 실패)');
              } else {
                log(`✅ 신규 후보 ${candidates.length}건 발견. 픽코 확정 처리 시작...`);
                for (const b of candidates) {
                  // 처리 마킹(먼저 저장해서 중복 방지)
                  seenSet.add(b._key);
                  seen.seenIds = Array.from(seenSet).slice(-500);
                  saveSeen(seen);

                  await runPickko(b);
                }
              }

              // 원래 캘린더로 복귀
              await page.goto(NAVER_URL, { waitUntil: 'networkidle2' });

            } catch (e) {
              log(`⚠️ 신규 확정 예약 처리 실패: ${e.message}`);
              // 안전하게 원래 페이지로 복귀
              try { await page.goto(NAVER_URL, { waitUntil: 'networkidle2' }); } catch (e2) {}
            }
          }
          
          // 변경된 항목 클릭해서 상세 정보 캡처
          try {
            log('📋 상세 예약 정보 캡처 중...');
            
            // 변경된 항목에 따라 클릭
            for (const change of changes) {
              const clickableSelector = change.name === '오늘 확정' 
                ? 'a[href*="bookingStatusCodes=RC03"]'
                : change.name === '오늘 이용'
                ? 'a[href*="countFilter=CONFIRMED"]'
                : 'a[href*="countFilter=CANCELLED"]';
              
              try {
                await page.click(clickableSelector);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
                
                // 상세 정보 스크린샷
                await page.screenshot({
                  path: path.join('/Users/alexlee/.openclaw/workspace', `booking-detail-${Date.now()}.png`),
                  fullPage: true
                });
                
                log('✅ 상세 정보 캡처 완료');
                
                // 뒤로 가기
                await page.goBack({ waitUntil: 'networkidle2', timeout: 5000 });
              } catch (err) {
                log(`⚠️ 상세 정보 캡처 실패: ${err.message}`);
              }
            }
          } catch (err) {
            log(`⚠️ 상세 정보 처리 실패: ${err.message}`);
          }
        } else {
          log('✅ 변경사항 없음');
        }
        
        // 상태 업데이트
        previousState = { ...currentState };
        
        // 다음 확인까지 대기
        const remainingTime = Math.max(0, MONITOR_DURATION - (Date.now() - startTime));
        const remainingMinutes = Math.floor(remainingTime / 60000);
        
        const nextSec = Math.floor(MONITOR_INTERVAL / 1000);
        log(`⏳ 다음 확인: ${nextSec}초 후 (남은 시간: ${remainingMinutes}분)`);
        
        await new Promise(resolve => setTimeout(resolve, MONITOR_INTERVAL));
        
      } catch (err) {
        log(`❌ 루프 오류: ${err.message}`);

        // ✅ 안전 모드: detached/connection closed 등 치명 오류 시 탭을 새로 만들지 않고
        // 잠시 멈췄다가(사장님이 "복구" 누를 시간) 같은 탭에서 재시도
        // (about:blank 탭 폭증 방지 + 브라우저 자동 종료 방지)
        const msg = String(err.message || '');
        if (/detached/i.test(msg) || /Connection closed/i.test(msg)) {
          log('🛑 치명 오류(detached/connection closed). 새 탭 생성 없이 30초 대기 후 재시도합니다. (필요하면 브라우저에서 "복구" 클릭)');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }

        await new Promise(resolve => setTimeout(resolve, MONITOR_INTERVAL));
      }
    }
    
    log('\n✅ 모니터링 완료 (2시간 경과)');
    log(`📊 총 ${checkCount}회 확인 수행`);
    
  } catch (err) {
    log(`❌ 치명적 오류: ${err.message}`);
  } finally {
    const isHeadless = process.env.NAVER_HEADLESS !== '0';
    if (browser) {
      if (isHeadless) {
        await browser.close();
        log('🔌 브라우저 종료');
      } else {
        log('🟢 NAVER_HEADLESS=0 상태: 브라우저를 닫지 않고 유지합니다(수동 확인/2단계 대비).');
      }
    }

    // 락 해제
    try {
      const LOCK_FILE = path.join('/Users/alexlee/.openclaw/workspace', 'naver-monitor.lock');
      fs.unlinkSync(LOCK_FILE);
    } catch (e) {}
  }
}

// ======================== Pickko 연동 ========================
const { spawn } = require('child_process');
const SEEN_FILE = path.join('/Users/alexlee/.openclaw/workspace', 'naver-seen.json');

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
  } catch (e) {
    return { seenIds: [] };
  }
}
function saveSeen(obj) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(obj, null, 2));
}

async function scrapeNewestBookingsFromList(page, limit = 5) {
  // "오늘 확정" 리스트 화면 파싱 (Div 기반 - BookingListView)
  // ✅ row는 a.BookingListView__contents-user__xNWR6

  // 리스트가 로딩될 시간을 줌 (nodata or rows)
  await page.waitForSelector(
    'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
    { timeout: 20000 }
  );

  // ✅ 요소가 실제로 렌더링될 때까지 대기 (Detached Frame 방지)
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('a[class*="contents-user"]');
    const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
    return rows.length > 0 || noData;
  }, { timeout: 20000 });

  return await page.evaluate((n) => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

    const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
    if (noData) return [];

    const rows = Array.from(document.querySelectorAll('a[class*="contents-user"]')).slice(0, n);
    if (rows.length === 0) return [];

    // ✅ 헬퍼 함수들
    const to24Start = (ampm, hh, mm) => {
      let h = parseInt(hh, 10);
      const m = String(parseInt(mm, 10)).padStart(2, '0');
      if (ampm === '오후' && h < 12) h += 12;
      if (ampm === '오전' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${m}`;
    };

    const to24End = (startAmpm, endHh, endMm) => {
      let h = parseInt(endHh, 10);
      const m = String(parseInt(endMm, 10)).padStart(2, '0');
      if (h === 12) {
        h = startAmpm === '오전' ? 12 : 0;
      } else if (startAmpm === '오후') {
        h += 12;
      }
      return `${String(h).padStart(2, '0')}:${m}`;
    };

    const out = [];
    for (const row of rows) {
      // ✅ BookingListView 구조에서 각 셀 추출
      const nameEl = row.querySelector('[class*="name__"]');
      const phoneEl = row.querySelector('[class*="phone__"] span');
      const bookDateEl = row.querySelector('[class*="book-date__"]');
      const hostEl = row.querySelector('[class*="host__"]');
      const bookIdEl = row.querySelector('[class*="book-number__"]');

      const name = clean(nameEl?.textContent);
      const phoneText = clean(phoneEl?.textContent);
      const phone = phoneText ? phoneText.replace(/\D/g, '') : null;
      const bookingId = clean(bookIdEl?.textContent);
      
      // 이용일시 텍스트: "26. 2. 23.(월) 오후 5:00~7:00"
      const dateTimeText = clean(bookDateEl?.textContent);
      let date = null;
      let start = null;
      let end = null;

      if (dateTimeText) {
        // 날짜 파싱 (26. 2. 23)
        const dateMatch = dateTimeText.match(/(\d{2})\.\s+(\d{1,2})\.\s+(\d{1,2})/);
        if (dateMatch) {
          const yyyy = `20${dateMatch[1]}`;
          const mm = String(parseInt(dateMatch[2], 10)).padStart(2, '0');
          const dd = String(parseInt(dateMatch[3], 10)).padStart(2, '0');
          date = `${yyyy}-${mm}-${dd}`;
        }

        // 시간 파싱 (오후 5:00~7:00)
        const timeMatch = dateTimeText.match(/(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const ampm = timeMatch[1];
          start = to24Start(ampm, timeMatch[2], timeMatch[3]);
          end = to24End(ampm, timeMatch[4], timeMatch[5]);
        }
      }

      // 룸 추출 (A1, A2, B)
      const hostText = clean(hostEl?.textContent);
      const roomMatch = hostText.match(/\b(A1|A2|B)\b/i);
      const room = roomMatch ? roomMatch[1].toUpperCase() : null;

      // 유효한 데이터만 추가
      if (phone && start && end && date) {
        const uniqueId = `${date}|${start}|${end}|${room}|${phone}`;
        out.push({ 
          bookingId: bookingId || uniqueId,
          phone, 
          date, 
          start, 
          end, 
          room, 
          raw: { name, dateTimeText, hostText, phoneText } 
        });
      }
    }

    return out;
  }, limit);
}

function runPickko(booking) {
  return new Promise((resolve) => {
    const args = [
      'pickko-accurate.js',
      `--phone=${booking.phone}`,
      `--date=${booking.date}`,
      `--start=${booking.start}`,
      `--end=${booking.end}`,
      `--room=${booking.room}`
    ];

    log(`🤖 픽코 확정 실행: ${args.join(' ')}`);

    const child = spawn('node', args, {
      cwd: __dirname, // ⚠️ Fix: 하드코딩 경로 → 현재 파일 기준 상대 경로
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (d) => process.stdout.write(d.toString()));
    child.stderr.on('data', (d) => process.stderr.write(d.toString()));

    child.on('close', (code) => {
      log(`🤖 픽코 실행 종료 code=${code}`);
      resolve(code);
    });
  });
}

// 실행
monitorBookings().catch(err => {
  log(`❌ 예상치 못한 오류: ${err.message}`);
  process.exit(1);
});

