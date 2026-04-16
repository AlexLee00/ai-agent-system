'use strict';

/**
 * 012_selector_history_seed.ts
 *
 * 목적:
 *   - 현재 운영 중인 네이버/픽코 셀렉터를 ska.selector_history에 초기 등록
 *   - ParsingGuard Level 1(CSS)/Level 2(XPath)가 이 데이터를 기반으로 동작
 *
 * 셀렉터 출처:
 *   - naver-list-scrape-service.ts (네이버 예약 리스트)
 *   - pickko.ts (픽코 주문 테이블)
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'ska';

exports.version = 12;
exports.name = 'selector_history_seed';

const SELECTORS = [
  // ─── 네이버 예약 리스트 ─────────────────────────────────
  {
    target: 'naver_list_rows',
    selector_css: 'a[class*="contents-user"]',
    selector_xpath: '//a[contains(@class,"contents-user")]',
    note: '네이버 예약 목록 행',
  },
  {
    target: 'naver_list_nodata',
    selector_css: '[class*="nodata-area"],[class*="nodata"],.nodata',
    selector_xpath: '//*[contains(@class,"nodata-area") or contains(@class,"nodata")]',
    note: '네이버 예약 없음 영역',
  },
  {
    target: 'naver_booking_name',
    selector_css: '[class*="name__"]',
    selector_xpath: '//*[contains(@class,"name__")]',
    note: '예약자 이름',
  },
  {
    target: 'naver_booking_phone',
    selector_css: '[class*="phone__"] span',
    selector_xpath: '//*[contains(@class,"phone__")]//span',
    note: '예약자 전화번호',
  },
  {
    target: 'naver_booking_date',
    selector_css: '[class*="book-date__"]',
    selector_xpath: '//*[contains(@class,"book-date__")]',
    note: '예약 날짜',
  },
  {
    target: 'naver_booking_host',
    selector_css: '[class*="host__"]',
    selector_xpath: '//*[contains(@class,"host__")]',
    note: '예약 호스트(객실) 정보',
  },
  {
    target: 'naver_booking_id',
    selector_css: '[class*="book-number__"]',
    selector_xpath: '//*[contains(@class,"book-number__")]',
    note: '예약 번호',
  },
  {
    target: 'naver_status_dropdown',
    selector_css: '[aria-labelledby="dropdownBookingStatus"],[class*="dropdown-menu"]',
    selector_xpath: '//*[@aria-labelledby="dropdownBookingStatus" or contains(@class,"dropdown-menu")]',
    note: '네이버 예약 상태 드롭다운',
  },
  {
    target: 'naver_close_btn',
    selector_css: '[class*="drawer__close"],[class*="side-panel__close"],[aria-label="닫기"]',
    selector_xpath: '//*[contains(@class,"drawer__close") or contains(@class,"side-panel__close") or @aria-label="닫기"]',
    note: '네이버 패널 닫기 버튼',
  },

  // ─── 픽코 주문 테이블 ───────────────────────────────────
  {
    target: 'pickko_order_rows',
    selector_css: 'tbody tr',
    selector_xpath: '//tbody//tr',
    note: '픽코 주문 테이블 행',
  },
  {
    target: 'pickko_order_detail_link',
    selector_css: 'a[href*="/study/view/"]',
    selector_xpath: '//a[contains(@href,"/study/view/")]',
    note: '픽코 주문 상세 링크',
  },
  {
    target: 'pickko_date_start',
    selector_css: 'input[name="sd_start_up"]',
    selector_xpath: '//input[@name="sd_start_up"]',
    note: '픽코 검색 시작 날짜',
  },
  {
    target: 'pickko_date_end',
    selector_css: 'input[name="sd_start_dw"]',
    selector_xpath: '//input[@name="sd_start_dw"]',
    note: '픽코 검색 종료 날짜',
  },
  {
    target: 'pickko_member_link',
    selector_css: 'a.detail_btn[href*="/member/view/"]',
    selector_xpath: '//a[contains(@class,"detail_btn") and contains(@href,"/member/view/")]',
    note: '픽코 회원 상세 링크',
  },
  {
    target: 'pickko_login_inputs',
    selector_css: 'input[type="text"]',
    selector_xpath: '//input[@type="text"]',
    note: '픽코 로그인 텍스트 입력',
  },
  {
    target: 'pickko_table_headers',
    selector_css: 'thead tr:last-child th',
    selector_xpath: '//thead//tr[last()]//th',
    note: '픽코 테이블 헤더',
  },
];

exports.up = async function () {
  for (const sel of SELECTORS) {
    await pgPool.run(SCHEMA, `
      INSERT INTO ska.selector_history
        (target, selector_css, selector_xpath, status, version)
      VALUES ($1, $2, $3, 'active', 1)
      ON CONFLICT DO NOTHING
    `, [sel.target, sel.selector_css, sel.selector_xpath]);
  }
};

exports.down = async function () {
  const targets = SELECTORS.map((s) => s.target);
  await pgPool.run(SCHEMA, `
    DELETE FROM ska.selector_history
    WHERE target = ANY($1) AND version = 1
  `, [targets]);
};
