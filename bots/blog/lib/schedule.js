'use strict';

/**
 * bots/blog/lib/schedule.js — 일자별 발행 스케줄 관리
 *
 * publish_schedule 테이블 기반 강의/일반 포스팅 스케줄 관리.
 * blo.js가 category-rotation 대신 이 모듈을 통해 오늘 할 일을 결정한다.
 *
 * 테스트 모드:
 *   BLOG_TEST_MODE=true → 강의 번호를 현재-2로 교체 (미래 포스팅 발행 방지)
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  getNextLectureNumber,
  getLectureTitle,
  getNextGeneralCategory,
} = require('./category-rotation');

const IS_TEST    = process.env.BLOG_TEST_MODE  === 'true';
const RUN_DATE   = process.env.BLOG_RUN_DATE  || null;   // YYYY-MM-DD, 미설정 시 오늘

function _today() {
  return RUN_DATE || new Date().toISOString().slice(0, 10);
}

// ─── 조회 ─────────────────────────────────────────────────────────────

/**
 * 오늘 발행 스케줄 조회 (lecture 먼저)
 * @returns {Array<ScheduleRow>}
 */
async function getTodaySchedule() {
  return getScheduleByDate(_today());
}

/**
 * 특정 날짜 발행 스케줄 조회
 * @param {string} date — YYYY-MM-DD
 * @returns {Array<ScheduleRow>}
 */
async function getScheduleByDate(date) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT * FROM blog.publish_schedule
      WHERE publish_date = $1
      ORDER BY CASE post_type WHEN 'lecture' THEN 1 ELSE 2 END
    `, [date]);
    return rows || [];
  } catch (e) {
    console.warn('[스케줄] 조회 실패:', e.message);
    return [];
  }
}

// ─── 업데이트 ─────────────────────────────────────────────────────────

/**
 * 스케줄 행 상태 업데이트
 * @param {number} id
 * @param {string} status — 'writing' | 'ready' | 'published'
 * @param {number|null} [postId]
 */
async function updateScheduleStatus(id, status, postId = null) {
  try {
    await pgPool.run('blog', `
      UPDATE blog.publish_schedule
      SET status = $1, post_id = COALESCE($2, post_id), updated_at = NOW()
      WHERE id = $3
    `, [status, postId, id]);
  } catch (e) {
    console.warn('[스케줄] 상태 업데이트 실패:', e.message);
  }
}

/**
 * 도서 정보 업데이트 (도서리뷰 전용)
 * @param {number} id
 * @param {{ book_title, book_author, book_isbn }} bookInfo
 */
async function updateBookInfo(id, bookInfo) {
  try {
    await pgPool.run('blog', `
      UPDATE blog.publish_schedule
      SET book_title = $1, book_author = $2, book_isbn = $3, updated_at = NOW()
      WHERE id = $4
    `, [bookInfo.book_title, bookInfo.book_author, bookInfo.book_isbn, id]);
  } catch (e) {
    console.warn('[스케줄] 도서 정보 업데이트 실패:', e.message);
  }
}

// ─── 자동 생성 ────────────────────────────────────────────────────────

/**
 * 스케줄이 없으면 category-rotation 기반으로 자동 생성
 * @param {string} [date] — YYYY-MM-DD (기본: 오늘)
 * @returns {Array<ScheduleRow>}
 */
async function ensureSchedule(date = _today()) {
  try {
    const existing = await getScheduleByDate(date);
    if (existing.length > 0) return existing;

    // category-rotation에서 현재 값 조회
    const { category } = await getNextGeneralCategory();

    await pgPool.run('blog', `
      INSERT INTO blog.publish_schedule (publish_date, post_type, category, status)
      VALUES
        ($1, 'lecture', 'Node.js강의', 'scheduled'),
        ($1, 'general', $2,            'scheduled')
      ON CONFLICT DO NOTHING
    `, [date, category]);

    console.log(`[스케줄] ${date} 자동 생성 — 일반 카테고리: ${category}`);
    return await getScheduleByDate(date);
  } catch (e) {
    console.warn('[스케줄] 자동 생성 실패:', e.message);
    return [];
  }
}

// ─── 테스트 모드 ──────────────────────────────────────────────────────

/**
 * 테스트 모드용 강의 번호 결정
 * BLOG_TEST_MODE=true → 현재번호-2 (최소 1강)
 * @returns {{ number, seriesName, lectureTitle }}
 */
async function resolveTestLecture() {
  const { number, seriesName } = await getNextLectureNumber();
  const testNum = Math.max(1, number - 2);
  const title   = await getLectureTitle(testNum, seriesName);
  console.log(`[스케줄] 🧪 TEST 모드 — 강의 ${number} → ${testNum}강 (${title || '제목 없음'})`);
  return { number: testNum, seriesName, lectureTitle: title || `제${testNum}강` };
}

// ─── 오늘 컨텍스트 조합 ──────────────────────────────────────────────

/**
 * 오늘 스케줄 + category-rotation 정보 결합
 * blo.js가 호출하여 오늘 작성할 강의/일반 포스팅 정보를 받는다.
 *
 * @returns {{
 *   lectureSchedule: ScheduleRow|null,   -- 오늘 강의 스케줄 (null=없음)
 *   generalSchedule: ScheduleRow|null,   -- 오늘 일반 스케줄 (null=없음)
 *   lectureCtx:  { number, seriesName, lectureTitle }|null,
 *   generalCtx:  { category }|null,
 * }}
 */
async function getTodayContext() {
  // 스케줄 없으면 자동 생성
  const schedule = await ensureSchedule();

  const lectureRow = schedule.find(r => r.post_type === 'lecture') || null;
  const generalRow = schedule.find(r => r.post_type === 'general') || null;

  // 이미 발행된 항목은 건너뜀 (재실행 안전)
  const needLecture = lectureRow && lectureRow.status !== 'published';
  const needGeneral = generalRow && generalRow.status !== 'published';

  let lectureCtx = null;
  if (needLecture) {
    if (IS_TEST) {
      lectureCtx = await resolveTestLecture();
    } else {
      const { number, seriesName } = await getNextLectureNumber();
      const title = lectureRow.lecture_title
        || (await getLectureTitle(number, seriesName))
        || `제${number}강`;
      lectureCtx = { number, seriesName, lectureTitle: title };
    }
  }

  let generalCtx = null;
  if (needGeneral) {
    // 스케줄에 명시된 카테고리 우선 사용
    const category = generalRow.category || (await getNextGeneralCategory()).category;
    generalCtx = { category, scheduleId: generalRow.id, bookInfo: {
      book_title:  generalRow.book_title  || null,
      book_author: generalRow.book_author || null,
      book_isbn:   generalRow.book_isbn   || null,
    }};
  }

  return {
    lectureSchedule: lectureRow,
    generalSchedule: generalRow,
    lectureCtx,
    generalCtx,
  };
}

module.exports = {
  getTodaySchedule,
  getScheduleByDate,
  updateScheduleStatus,
  updateBookInfo,
  ensureSchedule,
  resolveTestLecture,
  getTodayContext,
};
