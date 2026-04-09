'use strict';
const kst = require('../../../packages/core/lib/kst');
const env = require('../../../packages/core/lib/env');

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  getNextLectureNumber,
  getLectureTitle,
  getNextGeneralCategory,
} = require('./category-rotation');
let _curriculumPlanner = null;
function _getPlanner() {
  if (!_curriculumPlanner) {
    try { _curriculumPlanner = require('./curriculum-planner'); } catch { /* 미설치 */ }
  }
  return _curriculumPlanner;
}

const IS_TEST    = process.env.BLOG_TEST_MODE  === 'true';
const RUN_DATE   = process.env.BLOG_RUN_DATE  || null;
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

function _today() {
  return RUN_DATE || kst.today();
}

async function getTodaySchedule() {
  return getScheduleByDate(_today());
}

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

async function updateScheduleStatus(id, status, postId = null) {
  if (DEV_HUB_READONLY) return;
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

function isActionableScheduleStatus(status) {
  return status === 'scheduled' || status === 'writing' || status === 'ready';
}

async function updateBookInfo(id, bookInfo) {
  if (DEV_HUB_READONLY) return;
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

async function updateScheduleCategory(id, category) {
  if (DEV_HUB_READONLY) return;
  try {
    await pgPool.run('blog', `
      UPDATE blog.publish_schedule
      SET category = $1, updated_at = NOW()
      WHERE id = $2
    `, [category, id]);
  } catch (e) {
    console.warn('[스케줄] 카테고리 업데이트 실패:', e.message);
  }
}

async function ensureSchedule(date = _today()) {
  try {
    const existing = await getScheduleByDate(date);
    if (existing.length > 0) return existing;

    const { category } = await getNextGeneralCategory();

    if (DEV_HUB_READONLY) {
      console.log(`[스케줄] DEV/HUB 읽기 전용 — ${date} 합성 스케줄 사용 (${category})`);
      return [
        { id: null, publish_date: date, post_type: 'lecture', category: 'Node.js강의', status: 'scheduled' },
        { id: null, publish_date: date, post_type: 'general', category, status: 'scheduled' },
      ];
    }

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
    if (DEV_HUB_READONLY) {
      const { category } = await getNextGeneralCategory().catch(() => ({ category: '자기계발' }));
      return [
        { id: null, publish_date: date, post_type: 'lecture', category: 'Node.js강의', status: 'scheduled' },
        { id: null, publish_date: date, post_type: 'general', category, status: 'scheduled' },
      ];
    }
    return [];
  }
}

async function resolveTestLecture() {
  const { number, seriesName } = await getNextLectureNumber();
  const testNum = Math.max(1, number - 2);
  const title   = await getLectureTitle(testNum, seriesName);
  console.log(`[스케줄] 🧪 TEST 모드 — 강의 ${number} → ${testNum}강 (${title || '제목 없음'})`);
  return { number: testNum, seriesName, lectureTitle: title || `제${testNum}강` };
}

async function getTodayContext() {
  const schedule = await ensureSchedule();

  const lectureRow = schedule.find(r => r.post_type === 'lecture') || null;
  const generalRow = schedule.find(r => r.post_type === 'general') || null;

  const needLecture = lectureRow && isActionableScheduleStatus(lectureRow.status);
  const needGeneral = generalRow && isActionableScheduleStatus(generalRow.status);

  let lectureCtx = null;
  if (needLecture) {
    if (IS_TEST) {
      lectureCtx = await resolveTestLecture();
    } else {
      const nextLecture = await getNextLectureNumber();
      const number = Number(lectureRow.lecture_number || nextLecture.number);
      const seriesName = nextLecture.seriesName;
      const planner = _getPlanner();
      const curriculumTitle = planner
        ? await planner.getNextLectureTitle(seriesName, number).catch(() => null)
        : null;
      const title = lectureRow.lecture_title
        || curriculumTitle
        || (await getLectureTitle(number, seriesName))
        || `제${number}강`;
      lectureCtx = { number, seriesName, lectureTitle: title };
    }
  }

  let generalCtx = null;
  if (needGeneral) {
    const category = generalRow.category || (await getNextGeneralCategory()).category;
    generalCtx = { category, scheduleId: generalRow.id, bookInfo: {
      book_title:  generalRow.book_title  || null,
      book_author: generalRow.book_author || null,
      book_isbn:   generalRow.book_isbn   || null,
    }, topicHint: generalRow.lecture_title || null };
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
  updateScheduleCategory,
  ensureSchedule,
  resolveTestLecture,
  getTodayContext,
};
