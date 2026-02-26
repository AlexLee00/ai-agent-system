#!/usr/bin/env node

/**
 * 네이버 스마트플레이스 예약현황 모니터링 (Puppeteer 기반)
 * 5분 주기로 예약 현황 모니터링
 * 변경사항 감지 시 스크린샷 및 알림
 * 
 * ✅ VALIDATION_RULES.md에 정의된 검증 규칙 적용
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const { transformAndNormalizeData } = require('../lib/validation');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { sendTelegram: sendTelegramDirect } = require('../lib/telegram');
const fs = require('fs');
const path = require('path');

// 인증 정보 (secrets.json에서 로드)
const SECRETS = loadSecrets();
const NAVER_ID = SECRETS.naver_id;
const NAVER_PW = SECRETS.naver_pw;
const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
// kiosk-monitor가 새 탭으로 연결하기 위한 CDP 엔드포인트 파일
const NAVER_WS_FILE = path.join(WORKSPACE, 'naver-monitor-ws.txt');
// ✅ 홈(검은 예약현황 박스)로 바로 가는 URL
const NAVER_URL = 'https://new.smartplace.naver.com/bizes/place/3990161';
const MODE = (process.env.MODE || 'dev').toLowerCase();
// ⚠️ 변경/신규 프로세스 감지 시 자동으로 DEV 정책을 적용(픽코 실행 차단)
const SAFE_DEV_FALLBACK = (process.env.SAFE_DEV_FALLBACK || '1') === '1';
const MONITOR_INTERVAL = parseInt(process.env.NAVER_INTERVAL_MS || (MODE === 'ops' ? '300000' : '120000'), 10); // ops=5분, dev=2분 기본
const MONITOR_DURATION = 2 * 60 * 60 * 1000; // 2시간

// 이전 사이클 확정 리스트 (취소 감지용)
let previousConfirmedList = [];

// Heartbeat: 마지막 전송 시각 (1시간 주기)
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1시간
let lastHeartbeatTime = Date.now(); // 시작 직후 0분 Heartbeat 방지 (1시간 후 첫 발송)

// 일일 마감 요약 통계
let dailyStats          = { date: '', detected: 0, completed: 0, cancelled: 0, failed: 0 };
let lastDailyReportDate = '';
const MAX_RETRIES = 5; // 최대 재시도 횟수 (초과 시 수동 처리 알람 후 건너뜀)

// ✅ 데이터 검증은 lib/validation.js에서 import함
// (중복 제거 및 라이브러리 일관성)

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
  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
  try {
    if (attempt > 1) {
      log(`🔄 로그인 재시도 ${attempt}/${MAX_RETRY} (3초 대기)...`);
      await delay(3000);
    }
    log('🔐 네이버 로그인 시작...');

    // domcontentloaded로 먼저 로드 후 networkidle 별도 대기 (frame detach 방지)
    await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);

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
    // ⚠️ 주의: "최초 로그인이 필요한 메뉴입니다." 확인 버튼 클릭 시 navigation 발생
    //          → evaluate 내 btn.click() 금지 (frame detach 원인)
    //          → 버튼 좌표만 반환 후 page.mouse.click() + waitForNavigation으로 처리
    log('🔍 팝업 확인 중...');
    const popupBtnCoords = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const isVisible = btn.offsetParent !== null;
        if (isVisible && (text === '확인' || text === 'OK' || text === '닫기' || text === '완료' || text === '네' || text === 'Yes')) {
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, text };
        }
      }
      return null;
    });

    if (popupBtnCoords) {
      log(`🔍 팝업 버튼 감지: "${popupBtnCoords.text}" — navigation 대기 후 클릭`);
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
          page.mouse.click(popupBtnCoords.x, popupBtnCoords.y),
        ]);
        log('✅ 팝업 클릭 및 navigation 완료');
        await delay(1500);
      } catch (e) {
        log(`⚠️ 팝업 클릭 중 오류(무시): ${e.message}`);
      }
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

      // ✅ 2단계 인증/보안인증 감지 → 텔레그램 알림
      await delay(5000); // 로그인 클릭 후 페이지 전환 대기
      const securityCheck = await page.evaluate(() => {
        const url = window.location.href;
        const text = (document.body?.innerText || document.body?.textContent || '');
        const isNaverAuth = url.includes('nid.naver.com');
        const hasSecurityKeyword = /보안|인증|OTP|일회용|문자|전화|휴대폰|기기 등록|로그인 알림|보안문자|캡차|captcha/i.test(text);
        const alreadyDone = text.includes('오늘 확정') || text.includes('예약 현황');
        return { isNaverAuth, hasSecurityKeyword, alreadyDone, url: url.slice(0, 120) };
      }).catch(() => ({ isNaverAuth: false, hasSecurityKeyword: false, alreadyDone: false }));

      if (!securityCheck.alreadyDone && (securityCheck.isNaverAuth || securityCheck.hasSecurityKeyword)) {
        log(`🔐 보안인증 화면 감지: ${JSON.stringify(securityCheck)}`);
        sendTelegramDirect(
          `🔐 네이버 보안인증 필요!\n\n` +
          `로그인 후 추가 인증 화면이 감지됐어요.\n` +
          `원격으로 맥북에 접속해서 인증을 완료해주세요.\n\n` +
          `✅ 인증 완료되면 자동으로 모니터링이 재개됩니다.\n` +
          `⏳ 최대 30분 대기 후 자동으로 재시작됩니다.`
        );
      } else if (securityCheck.alreadyDone) {
        log('✅ 로그인 후 즉시 대시보드 감지 → 보안인증 불필요');
      }

      log('⏳ (필요시) IP보안/2단계 화면을 완료해주세요. 완료되면 업체 대시보드(오늘 확정)가 보입니다. 최대 30분 대기');

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
      }, { timeout: 30 * 60 * 1000 }).catch(() => null);

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
    const isRetryable = /detached|disconnected|closed|hang up|socket/i.test(err.message);
    log(`❌ 로그인/페이지 로드 실패 (시도 ${attempt}/${MAX_RETRY}): ${err.message}`);
    if (attempt < MAX_RETRY && isRetryable) continue; // frame detach 계열 → 재시도
    return false;
  }
  } // end for retry
  return false;
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
    
    const filename = path.join(WORKSPACE, `booking-${timestamp}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    log(`📸 스크린샷 저장: ${filename}`);
    return filename;
  } catch (err) {
    log(`❌ 스크린샷 실패: ${err.message}`);
    return null;
  }
}

// 개인정보 보호: 예약일 기준 7일 경과한 항목 자동 삭제 (전화번호 등 포함)
function cleanupExpiredSeen() {
  try {
    const data = loadSeen();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7); // 7일 전 기준
    const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"

    let removed = 0;
    for (const key of Object.keys(data)) {
      if (key === 'seenIds' || key === 'cancelledSeenIds') continue;
      const entry = data[key];
      if (entry?.date && entry.date < cutoffStr) {
        delete data[key];
        removed++;
      }
    }

    if (removed > 0) {
      saveSeen(data);
      log(`🧹 개인정보 자동 정리: 만료 예약 ${removed}건 삭제 (7일 경과)`);
    }
  } catch (err) {
    log(`⚠️ cleanupExpiredSeen 오류: ${err.message}`);
  }
}

// 야간 보류 로직 제거됨 — Bot API 직접 발송으로 24시간 즉시 전송

// 알람 파일 자동 정리
// - resolved: true (또는 필드 없는 구버전) → 48시간 후 삭제
// - resolved: false (미해결 오류) → 7일 후 삭제 (미해결 상태 추적 유지)
function cleanupOldAlerts() {
  try {
    const alertsFile = path.join(WORKSPACE, '.pickko-alerts.jsonl');
    if (!fs.existsSync(alertsFile)) return;

    const now = Date.now();
    const RESOLVED_TTL   = 48 * 60 * 60 * 1000;       // 48시간 (해결됨)
    const UNRESOLVED_TTL = 7  * 24 * 60 * 60 * 1000;  // 7일 (미해결 오류)

    const content = fs.readFileSync(alertsFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const activeAlerts = lines.filter(line => {
      try {
        const alert = JSON.parse(line);
        const age = now - new Date(alert.timestamp).getTime();
        // resolved 필드 없는 구버전은 resolved: true 취급 (48h TTL)
        const isUnresolved = alert.resolved === false;
        return age < (isUnresolved ? UNRESOLVED_TTL : RESOLVED_TTL);
      } catch (e) {
        return false;
      }
    });

    if (activeAlerts.length !== lines.length) {
      fs.writeFileSync(alertsFile, activeAlerts.map(a => a + '\n').join(''));
      log(`🧹 [정리] 알람 ${lines.length - activeAlerts.length}건 삭제 (해결됨 48h, 미해결 7일 초과)`);
    }
  } catch (err) {
    log(`⚠️ 알람 정리 실패: ${err.message}`);
  }
}

// 특정 예약에 대한 미해결 오류 알림을 "해결됨"으로 마킹
// 픽코 성공(code=0) 또는 수동 처리 완료 시 호출
function resolveAlertsByBooking(phone, date, start) {
  try {
    const alertsFile = path.join(WORKSPACE, '.pickko-alerts.jsonl');
    if (!fs.existsSync(alertsFile)) return;

    const lines = fs.readFileSync(alertsFile, 'utf-8').split('\n').filter(l => l.trim());
    let resolvedCount = 0;
    const resolvedAt = new Date().toISOString();

    const updated = lines.map(line => {
      try {
        const a = JSON.parse(line);
        // 미해결 오류 알림이고 phone+date+start가 모두 일치하는 경우
        if (
          a.resolved === false &&
          a.type === 'error' &&
          a.phone === phone &&
          a.date === date &&
          a.start === start
        ) {
          a.resolved = true;
          a.resolvedAt = resolvedAt;
          resolvedCount++;
          return JSON.stringify(a);
        }
        return line;
      } catch (e) { return line; }
    });

    if (resolvedCount > 0) {
      fs.writeFileSync(alertsFile, updated.join('\n') + '\n');
      log(`✅ [알림 해결] ${phone} ${date} ${start} → 오류 알림 ${resolvedCount}건 해결됨 마킹`);
    }
  } catch (err) {
    log(`⚠️ 알림 해결 마킹 실패: ${err.message}`);
  }
}

// 알람 파일에서 특정 timestamp 항목의 sent 상태 업데이트
function updateAlertSentStatus(file, timestamp, success) {
  try {
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const updated = lines.map(l => {
      try {
        const a = JSON.parse(l);
        if (a.timestamp === timestamp) {
          a.sent = success;
          a.sentAt = success ? new Date().toISOString() : null;
          return JSON.stringify(a);
        }
      } catch (e) {}
      return l;
    });
    fs.writeFileSync(file, updated.join('\n') + '\n');
  } catch (e) { log(`⚠️ 알람 상태 업데이트 실패: ${e.message}`); }
}

// 시작 시 미해결 오류 알림 요약 보고
async function reportUnresolvedAlerts() {
  try {
    const alertsFile = path.join(WORKSPACE, '.pickko-alerts.jsonl');
    if (!fs.existsSync(alertsFile)) return;

    const lines = fs.readFileSync(alertsFile, 'utf-8').split('\n').filter(l => l.trim());
    const unresolved = [];
    for (const line of lines) {
      try {
        const a = JSON.parse(line);
        if (a.resolved === false) unresolved.push(a);
      } catch (e) { /* skip */ }
    }

    if (unresolved.length === 0) {
      log('✅ [미해결 알림] 없음');
      return;
    }

    log(`⚠️ [미해결 알림] ${unresolved.length}건 감지`);
    let summary = `⚠️ 스카 재시작 — 미해결 오류 ${unresolved.length}건\n\n`;
    for (const a of unresolved) {
      const ageMins = Math.floor((Date.now() - new Date(a.timestamp).getTime()) / 60000);
      const ageText = ageMins >= 60 ? `${Math.floor(ageMins / 60)}시간 전` : `${ageMins}분 전`;
      summary += `• [${ageText}] ${a.title}\n`;
      if (a.phone) summary += `  📞 ${a.phone}`;
      if (a.date)  summary += `  📅 ${a.date}`;
      if (a.start) summary += `  ⏰ ${a.start}`;
      summary += '\n';
    }
    summary += '\n처리 완료 시 자동으로 해결됨 처리됩니다.';
    await sendTelegramDirect(summary);
    log(`📱 미해결 알림 ${unresolved.length}건 텔레그램 발송 완료`);
  } catch (err) {
    log(`⚠️ 미해결 알림 보고 실패: ${err.message}`);
  }
}

// sendTelegramDirect: lib/telegram.js에서 import됨 (Telegram Bot API 직접 호출)

// 알림 메시지 전송
// 🚀 개선된 알람 함수 (신규 예약, 결제 완료 등)
async function sendAlert(options) {
  try {
    const {
      type = 'info',  // 'new' | 'completed' | 'error' | 'info'
      title,
      customer,
      phone,
      date,
      start,   // 알림 해결 매칭용 (오류 알림에서 resolved 추적)
      time,
      room,
      amount,
      status,
      reason,
      action,
      error
    } = options;

    // 📋 알람 메시지 형식화
    let message = `${title}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    if (customer) message += `👤 고객: ${customer}\n`;
    if (phone) message += `📞 번호: ${phone}\n`;
    if (date) message += `📅 날짜: ${date}\n`;
    if (time) message += `⏰ 시간: ${time}\n`;
    if (room) message += `🏛️ 룸: ${room}\n`;
    if (amount) message += `💰 금액: ${amount}원\n`;
    if (status) message += `📊 상태: ${status}\n`;
    if (reason) message += `ℹ️ 사유: ${reason}\n`;
    if (error) message += `❌ 오류: ${error}\n`;
    
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (action) message += `✅ 조치: ${action}\n`;

    // 📢 로그 출력
    log(message);
    
    // 📁 파일에 기록
    const logFile = path.join(WORKSPACE, 'monitor-alert.log');
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logFile, `[${timestamp}] [${type.toUpperCase()}]\n${message}\n\n`);
    
    // 📱 텔레그램으로 알람 전송 (새 예약, 완료, 취소, 에러) — 24시간 즉시 발송
    if ((type === 'new' || type === 'completed' || type === 'cancelled' || type === 'error') && process.env.TELEGRAM_ENABLED !== '0') {
      try {
        // 1️⃣ 이력 파일에 저장
        const alertsFile = path.join(WORKSPACE, '.pickko-alerts.jsonl');
        const entryTimestamp = new Date().toISOString();
        const alertEntry = JSON.stringify({
          timestamp: entryTimestamp,
          type,
          title,
          message,
          phone: phone || null,
          date: date || null,
          start: start || null,
          resolved: type !== 'error',
          resolvedAt: type !== 'error' ? new Date().toISOString() : null,
          sent: false,
          sentAt: null
        });
        fs.appendFileSync(alertsFile, alertEntry + '\n');
        log(`💾 [알람 저장] ${type.toUpperCase()} - ${title}`);

        // 2️⃣ Bot API 직접 발송 (24시간, 재시도 포함)
        const sendOk = await sendTelegramDirect(message);
        if (sendOk) {
          updateAlertSentStatus(alertsFile, entryTimestamp, true);
        } else {
          log(`⚠️ [알람발송 실패] sent: false 유지`);
        }

        // 3️⃣ 48시간 정책 실행
        cleanupOldAlerts();

        // 4️⃣ 개인정보 보호: 7일 경과 예약 자동 삭제
        cleanupExpiredSeen();

      } catch (err) {
        log(`⚠️ 알람 전송 실패: ${err.message}`);
      }
    }
  } catch (err) {
    log(`⚠️ 알람 전송 실패: ${err.message}`);
  }
}

// 호환성을 위한 기존 함수명
async function sendNotification(message) {
  try {
    log(`📢 알림: ${message}`);
    
    // 파일에 기록
    const logFile = path.join(WORKSPACE, 'monitor-log.txt');
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (err) {
    log(`⚠️ 알림 전송 실패: ${err.message}`);
  }
}

// 메인 모니터링 함수
async function monitorBookings() {
  // ✅ 단일 인스턴스 보장: 구 프로세스 확인 후 종료
  const LOCK_FILE = path.join(WORKSPACE, 'naver-monitor.lock');
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // 프로세스 존재 확인
        log(`🔍 구 프로세스 발견 (PID: ${oldPid}) → 종료 중...`);
        process.kill(oldPid, 'SIGTERM');
        await delay(2000);
        // SIGTERM 후에도 살아있으면 강제 종료
        try { process.kill(oldPid, 'SIGKILL'); } catch (e) { /* 이미 종료됨 */ }
        log(`✅ 구 프로세스 종료 완료 (PID: ${oldPid})`);
      } catch (e) {
        log(`ℹ️ 구 프로세스 이미 종료됨 (PID: ${oldPid})`);
      }
    }
    fs.unlinkSync(LOCK_FILE);
  }
  let lockFd = null;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) {
    log(`⚠️ 락 파일 생성 실패: ${e.message}`);
    return;
  }

  let browser;
  const startTime = Date.now();
  let checkCount = 0;
  let detachRetryCount = 0; // detached Frame 재시도 카운터

  try {
    log('🚀 네이버 예약 모니터링 시작 (2시간)');

    // ⚠️ 시작 시 미해결 오류 알림 확인 (이전 세션에서 미처리된 건 보고)
    await reportUnresolvedAlerts();

    // Puppeteer 실행
    // ✅ 네이버 2단계 보안(추가인증) 때문에 최초 1회는 headless=false + userDataDir로 세션 저장 권장
    browser = await puppeteer.launch({
      headless: false, // 🖥️ 항상 브라우저 화면 표시
      defaultViewport: null, // 창 크기 = 뷰포트 (짤림 방지)
      userDataDir: path.join(WORKSPACE, 'naver-profile'),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-position=0,25',  // 📍 주 모니터 고정 (메뉴바 25px 아래)
        '--window-size=2294,1380', // 📺 맥북 해상도 기준 (2294x1432 - 메뉴바/독 여유)
        // ✅ 백그라운드/탭 회수(페이지 확보)로 인한 frame detach 완화
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TabDiscarding,Translate,BackForwardCache'
      ]
    });

    // CDP 엔드포인트 저장: kiosk-monitor가 새 탭으로 연결하기 위해 사용
    try { fs.writeFileSync(NAVER_WS_FILE, browser.wsEndpoint(), 'utf8'); } catch (e) {}
    log('📡 CDP 엔드포인트 저장됨 (kiosk-monitor 연결용)');

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
      const cycleStart = Date.now();

      try {
        // 매 회차 작업 탭을 홈으로 유도
        await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
        await ensureHomeFromCalendar(page);

        // ✅ 세션 만료 자동 감지 → 재로그인
        const sessionOk = await page.evaluate(() => {
          const t = document.body?.innerText || document.body?.textContent || '';
          return t.includes('오늘 확정') || t.includes('예약 현황');
        }).catch(() => false);
        if (!sessionOk) {
          log('⚠️ 세션 만료 감지 → 자동 재로그인 시도');
          const recovered = await naverLogin(page);
          if (recovered) {
            log('✅ 세션 자동 복구 완료');
          } else {
            log('❌ 세션 자동 복구 실패');
            sendTelegramDirect('⚠️ 네이버 세션 만료, 자동 재로그인 실패\n수동 확인이 필요합니다.');
          }
        }

        log(`\n📍 확인 #${checkCount}`);

        // ✅ 검은 박스(예약 현황) 리프레시 버튼 클릭 후 딜레이
        try {
          const refreshBtn = await page.$('button[class*="btn_refresh"]');
          if (refreshBtn) {
            log(`🖱️ 예약현황 새로고침 버튼 클릭`);
            await refreshBtn.click();
            const ms = parseInt(process.env.NAVER_REFRESH_DELAY_MS || '1200', 10);
            log(`⏱️ 새로고침 대기 ${ms}ms`);
            await delay(ms);
          }
        } catch (e) {
          log(`⚠️ 새로고침 클릭 실패(무시): ${e.message}`);
        }
        
        // 팝업 감지 및 자동 클릭 (모니터링 주기마다)
        await closePopupsIfPresent(page);
        
        // ✅ 오늘 날짜 & bizId (취소 URL 구성에 재사용)
        const todaySeoul = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        const bizId = NAVER_URL.match(/\/place\/(\d+)/)?.[1] || '';
        let currentConfirmedList = [];
        let cancelledHref = null; // 홈에서 추출한 취소 탭 href (스코프 공유)
        let cancelledCount = 0;   // 오늘 취소 카운터 (스코프 공유)
        let confirmedCount = 0;   // 오늘 확정 카운터 (취소 감지 1 스코프 공유)

        // ✅ 매 사이클 오늘 확정 리스트 파싱 (카운터 비교 없이 항상 실행)
        {
          try {
            log('🧩 오늘 확정 리스트 파싱 시도...');

            // 홈에서 "오늘 확정"/"오늘 취소" 카운터 + href 동시 추출
            const { confirmedHref: _confirmedHref, cancelledHref: _cancelledHref, confirmedCount: _confirmedCount, cancelledCount: _cancelledCount } = await page.evaluate(() => {
              const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
              const links = Array.from(document.querySelectorAll('a'));
              const confirmed = links.find(x => clean(x.textContent).includes('오늘 확정') && String(x.href || '').includes('booking-list-view'));
              const cancelled = links.find(x => clean(x.textContent).includes('오늘 취소') && String(x.href || '').includes('booking-list-view'));
              const getCount = (el) => {
                if (!el) return 0;
                const strong = el.querySelector('strong');
                const num = parseInt((strong ? strong.textContent : el.textContent).replace(/\D/g, ''), 10);
                return Number.isNaN(num) ? 0 : num;
              };
              return {
                confirmedHref: confirmed ? confirmed.href : null,
                cancelledHref: cancelled ? cancelled.href : null,
                confirmedCount: getCount(confirmed),
                cancelledCount: getCount(cancelled),
              };
            });
            confirmedCount = _confirmedCount; // 루프 스코프 변수에 저장 (취소 감지 1에서 재사용)
            cancelledCount = _cancelledCount; // 루프 스코프 변수에 저장
            cancelledHref = _cancelledHref;   // 루프 스코프 변수에 저장 (취소 감지 2에서 재사용)
            log(`📊 카운터: 오늘 확정=${confirmedCount}, 오늘 취소=${cancelledCount}`);
            let confirmedHref = _confirmedHref;
            // ⚠️ Fix: href를 못 찾으면 URL을 직접 구성해서 폴백
            if (!confirmedHref) {
              const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })
                .replace(/\./g, '').replace(/\s/g, '-').split('-').filter(Boolean)
                .map((v, i) => i === 0 ? v : v.padStart(2, '0')).join('-');
              const bizId = NAVER_URL.match(/\/place\/(\d+)/)?.[1] || NAVER_URL.split('/').filter(Boolean).pop();
              confirmedHref = `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CONFIRMED&date=${today}`;
              log(`⚠️ 오늘 확정 링크 자동 탐색 실패 → URL 직접 구성: ${confirmedHref}`);
            }

            if (confirmedCount === 0) {
              log('ℹ️ 오늘 확정 0건 → 리스트 파싱 스킵');
            } else {
            log(`🔗 오늘 확정 리스트 이동 (${confirmedCount}건): ${confirmedHref}`);
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

            const newest = await scrapeNewestBookingsFromList(page, 20);  // ✅ 10 → 20으로 변경 (확장성 고려)
            currentConfirmedList = newest; // ✅ 취소 감지를 위해 외부 변수에 저장
            log(`🧾 리스트 파싱 결과(상위): ${JSON.stringify(newest.slice(0, 3))}`);
            // ✅ 전체 데이터를 파일에 저장 (디버그용)
            try {
              const fullDataFile = path.join(WORKSPACE, 'naver-bookings-full.json');
              fs.writeFileSync(fullDataFile, JSON.stringify(newest, null, 2));
              log(`💾 전체 파싱 데이터 저장: ${fullDataFile} (${newest.length}건)`);
            } catch (e) {
              log(`⚠️ 전체 데이터 저장 실패: ${e.message}`);
            }
            
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

            // ✅ 완료/수동처리 건 사전 seenIds 마킹 (재감지 루프 방지)
            let autoMarked = 0;
            for (const b of newest) {
              const key = toKey(b);
              if (seenSet.has(key)) continue;
              const existing = seen[key];
              if (existing && (existing.status === 'completed' || existing.pickkoStatus === 'manual')) {
                seenSet.add(key);
                autoMarked++;
                log(`🔄 [자동마킹] ${existing.phone || b.phone} ${existing.date || b.date} → ${existing.pickkoStatus || existing.status} → seenIds 추가`);
                // 수동 처리 완료된 예약의 미해결 오류 알림 → 해결됨 마킹
                resolveAlertsByBooking(b.phone, b.date, b.start);
              }
            }
            if (autoMarked > 0) {
              seen.seenIds = pruneSeenIds(Array.from(seenSet), seen);
              saveSeen(seen);
            }

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
              
              // 🆕 신규 예약 감지 알람
              for (const booking of candidates) {
                const bookingId = booking._key || `${booking.phoneRaw}-${booking.date}-${booking.start}`;
                const state = updateBookingState(bookingId, booking, 'pending');

                await sendAlert({
                  type: 'new',
                  title: '🆕 신규 예약 감지!',
                  customer: booking.raw?.name || '고객',
                  phone: booking.phone,
                  date: booking.date,
                  time: `${booking.start}~${booking.end}`,
                  room: booking.room,
                  status: 'pending',
                  action: 'Pickko 자동 등록 준비 중...'
                });

                // 📚 RAG: 신규 예약 저장
                await ragSaveReservation(booking, '신규');
              }

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
                // 🔍 DEV 테스트: phoneRaw로 비교 (숫자 형식)
                const onlyMine = candidates.filter(b => String(b.phoneRaw) === devTestPhone);
                if (onlyMine.length === 0) {
                  log(`🧷 MODE=dev: 테스트 번호(${devTestPhone}) 후보 없음 → 픽코 실행 안 함`);
                  await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                  continue;
                }

                log(`🧪 DEV 픽코 테스트: ${devTestPhone} 대상 ${onlyMine.length}건만 실행`);

                // DEV: 성공(code=0)일 때만 마킹 (실패면 재시도 가능)
                for (const b of onlyMine) {
                  const bookingId = b._key || `${b.phoneRaw}-${b.date}-${b.start}`;
                  const code = await runPickko(b, bookingId, page);
                  if (code === 0) {
                    seenSet.add(b._key);
                    // 🛡️ 스냅샷 우선 사용 (타이밍 이슈 방어)
                    const freshSeen = (_lastSeenDataSnapshot && _lastSeenDataSnapshot[bookingId]) ? _lastSeenDataSnapshot : loadSeen();
                    _lastSeenDataSnapshot = null;
                    freshSeen.seenIds = pruneSeenIds(Array.from(seenSet), freshSeen);
                    saveSeen(freshSeen);
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
              // 🔍 OPS 관찰: phoneRaw로 비교 (observePhones는 이미 숫자만)
              const observeFiltered = observeOnly ? candidates.filter(b => observePhones.includes(String(b.phoneRaw))) : candidates;

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
                // fresh load: updateBookingState가 저장한 entry 객체 보존
                { const freshSeen = loadSeen(); freshSeen.seenIds = pruneSeenIds(Array.from(seenSet), freshSeen); saveSeen(freshSeen); }

                await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
                continue;
              }
              // OPS: 관찰 allowlist 필터를 적용하고, 성공(code=0) 또는 재시도 한도 초과(code=99) 시 seen 마킹
              for (const b of observeFiltered) {
                const bookingId = b._key || `${b.phoneRaw}-${b.date}-${b.start}`;
                const code = await runPickko(b, bookingId, page);
                if (code === 0) {
                  seenSet.add(b._key);
                  // 🛡️ 스냅샷 우선: updateBookingState가 방금 저장한 seenData를 직접 사용
                  // (loadSeen()이 간헐적으로 직전 저장본을 읽지 못하는 타이밍 이슈 방어)
                  { const freshSeen = (_lastSeenDataSnapshot && _lastSeenDataSnapshot[bookingId]) ? _lastSeenDataSnapshot : loadSeen(); _lastSeenDataSnapshot = null; freshSeen.seenIds = pruneSeenIds(Array.from(seenSet), freshSeen); saveSeen(freshSeen); }
                } else if (code === 99) {
                  // 최대 재시도 초과 → 재감지 차단 (수동 처리 필요 알람은 runPickko 내부에서 발송)
                  seenSet.add(b._key);
                  // fresh load: updateBookingState가 저장한 entry 객체 보존
                  { _lastSeenDataSnapshot = null; const freshSeen = loadSeen(); freshSeen.seenIds = pruneSeenIds(Array.from(seenSet), freshSeen); saveSeen(freshSeen); }
                  log(`⛔ 최대 재시도 초과 → seenIds 마킹 완료 (재감지 차단)`);
                } else {
                  log(`⚠️ OPS 픽코 실패(code=${code}) → seen 마킹 안 함(재시도 가능)`);
                }
              }
            }

            await page.goto(NAVER_URL, { waitUntil: 'networkidle2' });
            } // confirmedCount >= 1 else 닫힘
          } catch (e) {
            log(`⚠️ (상시) 오늘 확정 처리 실패: ${e.message}`);
            try { await page.goto(NAVER_URL, { waitUntil: 'networkidle2' }); } catch (e2) {}
          }
        }

        // ✅ 취소 감지 1: 이전 사이클 확정 리스트에서 사라진 항목 → 취소로 처리
        if (previousConfirmedList.length > 0 && process.env.PICKKO_CANCEL_ENABLE === '1') {
          // confirmedCount === 0 이면 페이지 로딩 글리치 가능성 → 취소 감지 스킵
          if (confirmedCount === 0) {
            log(`⚠️ 취소 감지 1 스킵: 카운터=0 (페이지 글리치 의심, 이전 확정 ${previousConfirmedList.length}건 유지)`);
          } else {
          try {
            const toKey = (b) => b.bookingId || `${b.date || todaySeoul}|${b.start}|${b.end}|${b.room}|${b.phone}`;
            const toCancelKey = (b) => `cancel|${b.date || todaySeoul}|${b.start}|${b.end}|${b.room}|${b.phoneRaw || b.phone.replace(/\D/g, '')}`;
            const currentKeys = new Set(currentConfirmedList.map(b => toKey(b)));
            const droppedFromConfirmed = previousConfirmedList.filter(b => !currentKeys.has(toKey(b)));

            if (droppedFromConfirmed.length > 0) {
              log(`🗑️ 확정 리스트에서 ${droppedFromConfirmed.length}건 사라짐 → 취소 처리`);
              const seen = loadSeen();
              const cancelledSeenSet = new Set(seen.cancelledSeenIds || []);

              for (const c of droppedFromConfirmed) {
                const cancelKey = toCancelKey(c);
                if (!cancelledSeenSet.has(cancelKey)) {
                  cancelledSeenSet.add(cancelKey);
                  seen.cancelledSeenIds = Array.from(cancelledSeenSet).slice(-500);
                  saveSeen(seen);
                  await runPickkoCancel(c, cancelKey);
                }
              }
            } else {
              log('ℹ️ 확정 리스트 변화 없음');
            }
          } catch (dropErr) {
            log(`⚠️ 확정→취소 감지 중 오류: ${dropErr.message}`);
          }
          } // end confirmedCount !== 0 guard
        }

        // ✅ 취소 감지 2: 오늘 취소 탭 파싱 (더블 체크)
        // cancelledCount >= 1: 취소 있음 확인 / !cancelledHref: 카운터 파싱 실패 → 폴백 URL로 반드시 방문
        if (process.env.PICKKO_CANCEL_ENABLE === '1' && (cancelledCount >= 1 || !cancelledHref)) {
          try {
            // 홈에서 추출한 href 우선, 없으면 폴백 URL 구성
            const cancelHref = cancelledHref || `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CANCELLED&date=${todaySeoul}`;
            log(`🔗 오늘 취소 탭 이동: ${cancelHref}`);
            await page.goto(cancelHref, { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForSelector(
              'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
              { timeout: 20000 }
            ).catch(() => null);
            await delay(500);

            const cancelledList = await scrapeNewestBookingsFromList(page, 20);
            log(`🗑️ 오늘 취소 탭: ${cancelledList.length}건`);

            if (cancelledList.length > 0) {
              const seen = loadSeen();
              const cancelledSeenSet = new Set(seen.cancelledSeenIds || []);
              const toCancelKey = (b) => `cancel|${b.date || todaySeoul}|${b.start}|${b.end}|${b.room}|${b.phoneRaw || b.phone.replace(/\D/g, '')}`;
              const cancelCandidates = cancelledList.filter(c => !cancelledSeenSet.has(toCancelKey(c)));

              if (cancelCandidates.length > 0) {
                log(`🗑️ 취소 탭 신규 취소: ${cancelCandidates.length}건`);
                for (const c of cancelCandidates) {
                  const cancelKey = toCancelKey(c);
                  cancelledSeenSet.add(cancelKey);
                  seen.cancelledSeenIds = Array.from(cancelledSeenSet).slice(-500);
                  saveSeen(seen);
                  await runPickkoCancel(c, cancelKey);
                }
              } else {
                log('ℹ️ 취소 탭 신규 취소 없음');
              }
            }

            await page.goto(NAVER_URL, { waitUntil: 'networkidle2' }).catch(() => null);
          } catch (cancelErr) {
            log(`⚠️ 취소 탭 처리 중 오류: ${cancelErr.message}`);
            try { await page.goto(NAVER_URL, { waitUntil: 'networkidle2' }); } catch (e2) {}
          }
        }

        // ✅ previousConfirmedList 업데이트
        previousConfirmedList = currentConfirmedList;
        detachRetryCount = 0; // 정상 완료 시 재시도 카운터 리셋

        // ✅ Heartbeat: 1시간마다 텔레그램으로 생존 신호 전송 (09:00~22:00만)
        if (Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
          const hHour = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).replace(/\D/g, ''), 10);
          if (hHour >= 9 && hHour < 22) {
            const upMin = Math.floor((Date.now() - startTime) / 60000);
            const hMsg = `✅ 스카 정상 운영 중\n\n확인 #${checkCount} | 업타임 ${upMin}분\n오늘 확정: ${currentConfirmedList.length}건 | 오늘 취소: ${cancelledCount}건\n다음 heartbeat: 1시간 후`;
            sendTelegramDirect(hMsg);
            log(`💓 Heartbeat 전송 (확인 #${checkCount}, 업타임 ${upMin}분)`);
            lastHeartbeatTime = Date.now();
          }

          // ✅ 일일 마감 요약 (22:00 이후, 하루 1회)
          const hDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
          const hHourFull = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).replace(/\D/g, ''), 10);
          if (hHourFull >= 22 && lastDailyReportDate !== hDateStr) {
            const dayMsg =
              `📊 스카 일일 마감 요약 (${hDateStr})\n\n` +
              `✅ 신규 등록 완료: ${dailyStats.completed}건\n` +
              `🚫 취소 처리: ${dailyStats.cancelled}건\n` +
              `⚠️ 등록 실패: ${dailyStats.failed}건\n` +
              `🔍 감지 총계: ${dailyStats.detected}건`;
            sendTelegramDirect(dayMsg);
            log(`📊 일일 마감 요약 전송: 등록${dailyStats.completed} 취소${dailyStats.cancelled} 실패${dailyStats.failed} 감지${dailyStats.detected}`);
            lastDailyReportDate = hDateStr;
            dailyStats = { date: hDateStr, detected: 0, completed: 0, cancelled: 0, failed: 0 };
          }
        }

        // 사이클 소요 시간 기반 대기 (타임아웃 누적으로 인한 주기 밀림 방지)
        const cycleElapsed = Date.now() - cycleStart;
        const sleepMs = Math.max(0, MONITOR_INTERVAL - cycleElapsed);
        const remainingTime = Math.max(0, MONITOR_DURATION - (Date.now() - startTime));
        const remainingMinutes = Math.floor(remainingTime / 60000);

        const nextSec = Math.floor(sleepMs / 1000);
        log(`⏳ 다음 확인: ${nextSec}초 후 (사이클 소요: ${Math.floor(cycleElapsed / 1000)}초, 남은 시간: ${remainingMinutes}분)`);

        await new Promise(resolve => setTimeout(resolve, sleepMs));
        
      } catch (err) {
        log(`❌ 루프 오류: ${err.message}`);

        const msg = String(err.message || '');
        if (/detached/i.test(msg) || /Connection closed/i.test(msg)) {
          detachRetryCount++;
          if (detachRetryCount >= 3) {
            log(`🛑 detached 오류 ${detachRetryCount}회 누적 → start-ops.sh 재시작 위임`);
            rollbackProcessingEntries();
            process.exit(1);
          }
          log(`⚠️ detached 오류 (${detachRetryCount}/3) → 페이지 재생성 후 재시도`);
          try {
            await page.close().catch(() => {});
            page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            const reloggedIn = await naverLogin(page);
            if (!reloggedIn) {
              log('❌ 재로그인 실패 → 재시작 위임');
              rollbackProcessingEntries();
              process.exit(1);
            }
            log('✅ 페이지 재생성 + 재로그인 완료 → 모니터링 계속');
          } catch (recreateErr) {
            log(`❌ 페이지 재생성 실패: ${recreateErr.message} → 재시작 위임`);
            rollbackProcessingEntries();
            process.exit(1);
          }
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

    // CDP 엔드포인트 파일 정리
    try { fs.unlinkSync(NAVER_WS_FILE); } catch (e) {}

    // 락 해제
    try {
      const LOCK_FILE = path.join(WORKSPACE, 'naver-monitor.lock');
      fs.unlinkSync(LOCK_FILE);
    } catch (e) {}
  }
}

// ======================== RAG 연동 ========================
const RAG_API = process.env.RAG_API_URL || 'http://localhost:8100';

async function ragSaveReservation(booking, status = '신규') {
  try {
    const name = booking.raw?.name || '고객';
    const text = [
      `예약자: ${name}`,
      `날짜: ${booking.date}`,
      `시간: ${booking.start}~${booking.end}`,
      `공간: ${booking.room}`,
      `전화: ${booking.phone}`,
      `상태: ${status}`,
    ].join(' | ');

    const meta = {
      type: 'reservation',
      date: String(booking.date || ''),
      status: String(status),
      room: String(booking.room || ''),
      phone: String(booking.phone || ''),
      bookingId: String(booking.bookingId || booking._key || ''),
      savedAt: new Date().toISOString(),
    };

    const res = await fetch(`${RAG_API}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'reservations', texts: [text], metadatas: [meta] }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`📚 [RAG] 저장 완료: ${booking.phone} / ${booking.date} ${booking.start}~${booking.end} (${status})`);
  } catch (err) {
    log(`⚠️ [RAG] 저장 실패(무시): ${err.message}`);
  }
}

// ======================== Pickko 연동 ========================
const SEEN_FILE = path.join(__dirname, '..', MODE === 'ops' ? 'naver-seen.json' : 'naver-seen-dev.json');  // OPS/DEV 데이터 격리

// 🛡️ updateBookingState가 저장한 seenData 스냅샷 (타이밍 이슈 방어)
// loadSeen()이 간헐적으로 직전 저장본을 읽지 못하는 현상 대비
let _lastSeenDataSnapshot = null;

// 📁 naver-seen.json 형식 개선 (상태 추적)
function loadSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
    return data || {};
  } catch (e) {
    return {};
  }
}

function saveSeen(obj) {
  try {
    const json = JSON.stringify(obj, null, 2);
    const tmp = SEEN_FILE + '.tmp';
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, SEEN_FILE);
    const count = Object.keys(obj).length;
    log(`💾 [저장] naver-seen.json 업데이트 (총 ${count}건)`);
  } catch (err) {
    log(`❌ [저장 실패] naver-seen.json: ${err.message}`);
  }
}

// 🛡️ process.exit 전 processing 상태 항목을 failed로 롤백
function rollbackProcessingEntries() {
  try {
    const data = loadSeen();
    let changed = 0;
    for (const [id, entry] of Object.entries(data)) {
      if (id === 'seenIds' || id === 'cancelledSeenIds') continue;
      if (entry && entry.status === 'processing') {
        entry.status = 'failed';
        entry.errorReason = '프로세스 강제 종료 (rollback)';
        changed++;
      }
    }
    if (changed > 0) {
      saveSeen(data);
      log(`🔄 [롤백] processing → failed 전환 ${changed}건`);
    }
  } catch (e) {
    log(`⚠️ [롤백 실패] ${e.message}`);
  }
}

// 날짜 기준 만료 seenId 정리 (cutoffDays일 이상 지난 예약 ID 제거)
// 엔트리가 없거나 날짜가 없는 ID는 안전하게 유지
function pruneSeenIds(ids, seenData, cutoffDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cutoffDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return ids.filter(id => {
    const entry = seenData[id];
    if (!entry || !entry.date) return true;
    return entry.date >= cutoffStr;
  });
}

// 🔐 신규 예약 감지 및 상태 저장
function updateBookingState(bookingId, booking, state = 'pending') {
  try {
    const seenData = loadSeen();
    
    if (!seenData[bookingId]) {
      // 🆕 신규 예약
      seenData[bookingId] = {
        compositeKey: `${booking.phoneRaw}-${booking.date}-${booking.start}`,
        name: booking.raw?.name || null,
        phone: booking.phone,
        phoneRaw: booking.phoneRaw,
        date: booking.date,
        start: booking.start,
        end: booking.end,
        room: booking.room,
        detectedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        status: state,            // pending → processing → completed → failed
        pickkoStatus: null,       // null → registered → paid
        pickkoOrderId: null,
        errorReason: null,
        retries: 0
      };
      log(`   📊 [신규] ${booking.phone} / ${booking.date} ${booking.start}~${booking.end} ${booking.room} → status: ${state}`);
      dailyStats.detected++;
    } else {
      // 기존 예약 상태 업데이트
      const oldStatus = seenData[bookingId].status;
      seenData[bookingId].status = state;
      
      if (state === 'processing') {
        seenData[bookingId].pickkoStartTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      } else if (state === 'completed') {
        seenData[bookingId].pickkoStatus = 'paid';
        seenData[bookingId].pickkoCompleteTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        dailyStats.completed++;
      } else if (state === 'failed') {
        seenData[bookingId].retries = (seenData[bookingId].retries || 0) + 1;
        dailyStats.failed++;
      }
      
      log(`   📊 [업데이트] ${booking.phone}: ${oldStatus} → ${state}`);
    }
    
    saveSeen(seenData);
    _lastSeenDataSnapshot = seenData; // 🛡️ freshSeen 타이밍 이슈 방어용 캐시
    return seenData[bookingId];
  } catch (err) {
    log(`❌ updateBookingState 실패: ${err.message}`);
    return null;
  }
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

    const to24End = (endAmpm, endHh, endMm) => {
      let h = parseInt(endHh, 10);
      const m = String(parseInt(endMm, 10)).padStart(2, '0');
      // 🔧 FIX: 종료 시간의 오전/오후를 독립적으로 처리
      if (endAmpm === '오후' && h < 12) h += 12;
      if (endAmpm === '오전' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${m}`;
    };

    // ✅ 전화번호 포맷팅: 01035000586 → 010-3500-0586
    const formatPhone = (phoneNoHyphen) => {
      if (!phoneNoHyphen || phoneNoHyphen.length !== 11) return phoneNoHyphen;
      return `${phoneNoHyphen.slice(0, 3)}-${phoneNoHyphen.slice(3, 7)}-${phoneNoHyphen.slice(7)}`;
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

        // 시간 파싱 (오전 12:00~오후 1:00 또는 오후 5:00~7:00)
        // 🔧 개선: 종료 시간의 오전/오후가 명시된 경우 캡처
        const timeMatch = dateTimeText.match(/(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const startAmpm = timeMatch[1];
          const startHour = parseInt(timeMatch[2], 10);
          const startMin = parseInt(timeMatch[3], 10);
          const endHour = parseInt(timeMatch[5], 10);
          const endMin = parseInt(timeMatch[6], 10);
          
          let endAmpm = timeMatch[4];  // 명시된 종료 오전/오후
          
          // 🔧 FIX: 종료 오전/오후가 생략된 경우 24시간 형식으로 비교
          if (!endAmpm) {
            // 시작을 24시간 형식으로 변환
            const start24Hour = startAmpm === '오전' 
              ? (startHour === 12 ? 0 : startHour)
              : (startHour === 12 ? 12 : startHour + 12);
            
            // 종료를 먼저 12시간 형식으로 가정하고 결정
            // 1) 종료 시간이 1~11이면서 시작이 오전이면 오전
            if ((endHour >= 1 && endHour <= 11) && startAmpm === '오전') {
              endAmpm = '오전';
            }
            // 2) 종료 시간이 12이고 시작이 오전이면 정오(오후 12)
            else if (endHour === 12 && startAmpm === '오전') {
              endAmpm = '오후';
            }
            // 3) 시작이 오후이고 종료가 1~12이면 오후
            else if (startAmpm === '오후' && endHour >= 1 && endHour <= 12) {
              endAmpm = '오후';
            }
            // 4) 그 외: 시작값 따라가기
            else {
              endAmpm = startAmpm;
            }
          }
          
          start = to24Start(startAmpm, String(startHour), String(startMin).padStart(2, '0'));
          end = to24End(endAmpm, String(endHour), String(endMin).padStart(2, '0'));
        }
      }

      // 룸 추출 (A1, A2, B)
      const hostText = clean(hostEl?.textContent);
      const roomMatch = hostText.match(/\b(A1|A2|B)\b/i);
      const room = roomMatch ? roomMatch[1].toUpperCase() : null;

      // 유효한 데이터만 추가
      if (phone && start && end && date) {
        const phoneFormatted = formatPhone(phone);
        const uniqueId = `${date}|${start}|${end}|${room}|${phone}`;
        out.push({ 
          bookingId: bookingId || uniqueId,
          phone: phoneFormatted,  // ✅ 포맷팅된 전화번호 (010-3500-0586)
          phoneRaw: phone,  // 원본 (01035000586)
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

// ======================== Pickko 취소 연동 ========================

function runPickkoCancel(booking, cancelKey = null) {
  return new Promise(async (resolve) => {
    const args = [
      'pickko-cancel.js',
      `--phone=${booking.phoneRaw || booking.phone.replace(/\D/g, '')}`,
      `--date=${booking.date}`,
      `--start=${booking.start}`,
      `--end=${booking.end}`,
      `--room=${booking.room}`,
      `--name=${(booking.raw?.name || '고객').slice(0, 20)}`
    ];

    log(`🗑️ 픽코 취소 실행: ${booking.phone} / ${booking.date} ${booking.start}~${booking.end} / ${booking.room}`);

    const child = spawn('node', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(d.toString()));
    child.stderr.on('data', d => process.stderr.write(d.toString()));

    child.on('close', (code) => {
      if (code === 0) {
        dailyStats.cancelled++;
        sendAlert({
          type: 'cancelled',
          title: '🗑️ 픽코 예약 취소 완료!',
          phone: booking.phone,
          date: booking.date,
          time: `${booking.start}~${booking.end}`,
          room: booking.room,
          action: '정상 취소 처리됨'
        });
        ragSaveReservation(booking, '취소완료');
      } else {
        sendAlert({
          type: 'error',
          title: '❌ 픽코 취소 실패',
          phone: booking.phone,
          date: booking.date,
          start: booking.start,
          time: `${booking.start}~${booking.end}`,
          room: booking.room,
          reason: `exit code ${code}`,
          action: '수동 취소 필요'
        });
        // 즉시 텔레그램 수동 처리 요청
        sendTelegramDirect(
          `🚨 픽코 취소 실패 — 수동 처리 필요!\n\n` +
          `📞 고객: ${booking.phone}\n` +
          `📅 날짜: ${booking.date}\n` +
          `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n\n` +
          `픽코에서 직접 취소해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
        );
      }
      resolve(code);
    });
  });
}

function runPickko(booking, bookingId = null, naveraPage = null) {
  return new Promise(async (resolve) => {
    // ✅ 픽코 호출 직전 최종 변환 확인 (안전장치)
    const normalized = transformAndNormalizeData(booking);
    if (!normalized) {
      log(`❌ 픽코 호출 전 변환 실패: ${JSON.stringify(booking)}`);
      
      if (bookingId) {
        updateBookingState(bookingId, booking, 'failed');
        await sendAlert({
          type: 'error',
          title: '❌ 데이터 변환 실패',
          phone: booking.phone,
          date: booking.date,
          start: booking.start,
          time: `${booking.start}~${booking.end}`,
          room: booking.room,
          reason: '정규식 변환 실패',
          action: '수동 확인 필요'
        });
      }
      
      return resolve(1); // 변환 오류 → code 1
    }

    // ⛔ 최대 재시도 초과 확인
    if (bookingId) {
      const currentData = loadSeen();
      const currentRetries = currentData[bookingId]?.retries || 0;
      if (currentRetries >= MAX_RETRIES) {
        log(`⛔ [건너뜀] 최대 재시도 초과 (${currentRetries}회): ${booking.phone} ${booking.date}`);
        sendTelegramDirect(
          `⛔ 픽코 등록 포기 — 최대 재시도 초과!\n\n` +
          `📞 고객: ${booking.phone}\n📅 날짜: ${booking.date}\n` +
          `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n` +
          `🔄 시도 횟수: ${currentRetries}회 (한도: ${MAX_RETRIES}회)\n\n` +
          `픽코에서 직접 등록해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
        );
        return resolve(99); // 재시도 한도 초과
      }
    }

    // 📊 상태 업데이트: processing
    if (bookingId) {
      updateBookingState(bookingId, booking, 'processing');
    }

    // 픽코는 별도 spawn 프로세스 → 네이버 페이지 닫을 필요 없음 (닫으면 detached Frame 발생)

    const customerName = (booking.raw?.name || '고객').slice(0, 20);
    const args = [
      'pickko-accurate.js',
      `--phone=${normalized.phone}`,
      `--date=${normalized.date}`,
      `--start=${normalized.start}`,
      `--end=${normalized.end}`,  // 픽코는 자동으로 표기시간 = 저장시간 - 10분 처리
      `--room=${normalized.room}`,
      `--name=${customerName}`
    ];

    log(`✅ [변환완료] 🤖 픽코 실행 시작`);
    log(`   📞 고객: ${normalized.phone}`);
    log(`   📅 날짜: ${normalized.date}`);
    log(`   ⏰ 시간: ${normalized.start}~${normalized.end} (네이버 & 픽코 등록) → 픽코 표기: ${normalized.start}~??:?? (-10분)`);
    log(`   🏛️ 룸: ${normalized.room}`);

    const child = spawn('node', args, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (d) => process.stdout.write(d.toString()));
    child.stderr.on('data', (d) => process.stderr.write(d.toString()));

    child.on('close', (code) => {
      log(`🤖 픽코 실행 종료 (exit code: ${code})`);
      
      // 📊 상태 업데이트 (성공/실패)
      if (code === 0) {
        // ✅ 성공
        if (bookingId) {
          updateBookingState(bookingId, booking, 'completed');

          // 📢 완료 알람
          sendAlert({
            type: 'completed',
            title: '✅ 픽코 예약 완료!',
            customer: booking.phoneText || '고객',
            phone: booking.phone,
            date: booking.date,
            time: `${booking.start}~${booking.end}`,
            room: booking.room,
            status: 'paid',
            action: '정상 처리됨'
          });

          // 📚 RAG: 픽코 완료 상태로 업데이트 저장
          ragSaveReservation(booking, '픽코완료');

          // ✅ 이 예약에 대한 미해결 오류 알림 → 해결됨 마킹
          resolveAlertsByBooking(booking.phone, booking.date, booking.start);
        }
        log(`✅ [완료] 픽코 예약이 성공했습니다!`);
      } else {
        // ❌ 실패
        if (bookingId) {
          updateBookingState(bookingId, booking, 'failed');

          // 📢 실패 알람
          sendAlert({
            type: 'error',
            title: '❌ 픽코 예약 실패',
            customer: booking.phoneText || '고객',
            phone: booking.phone,
            date: booking.date,
            start: booking.start,
            time: `${booking.start}~${booking.end}`,
            room: booking.room,
            reason: `exit code ${code}`,
            action: '수동 확인 필요'
          });

          // 📚 RAG: 픽코 실패 상태로 저장
          ragSaveReservation(booking, '픽코실패');

          // 즉시 텔레그램 수동 처리 요청
          const failedData = loadSeen();
          const retryCount = failedData[bookingId]?.retries || 1;
          sendTelegramDirect(
            `🚨 픽코 등록 실패 — 수동 처리 필요!\n\n` +
            `📞 고객: ${booking.phone}\n` +
            `📅 날짜: ${booking.date}\n` +
            `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n` +
            `🔄 시도 횟수: ${retryCount}회\n\n` +
            `픽코에서 직접 등록해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
          );
        }
        log(`❌ [실패] 픽코 예약이 실패했습니다 (code=${code})`);
      }
      
      resolve(code);
    });
  });
}

// 실행
monitorBookings().catch(err => {
  log(`❌ 예상치 못한 오류: ${err.message}`);
  rollbackProcessingEntries();
  process.exit(1);
});

