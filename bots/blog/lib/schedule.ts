'use strict';
const kst = require('../../../packages/core/lib/kst');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  getNextLectureNumber,
  getLectureTitle,
  getNextGeneralCategory,
} = require('./category-rotation.ts');
const { ensureBlogCoreSchema } = require('./schema.ts');
const GENERAL_CATEGORIES = [
  '자기계발', '도서리뷰', '성장과성공', '홈페이지와App',
  '최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅',
];

let _curriculumPlanner = null;
function _getPlanner() {
  if (!_curriculumPlanner) {
    try { _curriculumPlanner = require('./curriculum-planner.ts'); } catch {}
  }
  return _curriculumPlanner;
}

const IS_TEST = process.env.BLOG_TEST_MODE === 'true';
const RUN_DATE = process.env.BLOG_RUN_DATE || null;
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

function _today() {
  return RUN_DATE || kst.today();
}

function _realToday() {
  return kst.today();
}

function _isDbPermissionError(error) {
  return String(error?.code || '').trim() === 'EPERM';
}

async function _buildSyntheticSchedule(date = _today()) {
  const lecture = await _resolveLecturePlan(date).catch(() => ({ number: 1, lectureTitle: '제1강', seriesName: 'nodejs_120' }));
  const general = await _resolveGeneralPlan(date).catch(() => ({ category: '자기계발' }));
  return [
    {
      id: null,
      publish_date: date,
      post_type: 'lecture',
      category: 'Node.js강의',
      lecture_number: lecture.number,
      lecture_title: lecture.lectureTitle,
      status: 'scheduled',
    },
    { id: null, publish_date: date, post_type: 'general', category: general.category, status: 'scheduled' },
  ];
}

function _nextGeneralCategoryFrom(previousCategory) {
  const previousIndex = GENERAL_CATEGORIES.indexOf(previousCategory);
  const baseIndex = previousIndex >= 0
    ? (previousIndex + 1) % GENERAL_CATEGORIES.length
    : 0;
  return GENERAL_CATEGORIES[baseIndex];
}

async function _resolveLecturePlan(date = _today()) {
  const realToday = _realToday();
  const futurePrevious = date > realToday
    ? await pgPool.get('blog', `
      SELECT COALESCE(s.lecture_number, p.lecture_number) AS lecture_number
      FROM blog.publish_schedule s
      LEFT JOIN blog.posts p ON p.id = s.post_id
      WHERE s.post_type = 'lecture'
        AND s.publish_date < $1
        AND s.publish_date > $2
      ORDER BY s.publish_date DESC, s.id DESC
      LIMIT 1
    `, [date, realToday])
    : null;

  const previous = futurePrevious?.lecture_number
    ? futurePrevious
    : await pgPool.get('blog', `
      SELECT COALESCE(s.lecture_number, p.lecture_number) AS lecture_number
      FROM blog.publish_schedule s
      LEFT JOIN blog.posts p ON p.id = s.post_id
      WHERE s.post_type = 'lecture'
        AND s.publish_date < $1
      ORDER BY s.publish_date DESC, s.id DESC
      LIMIT 1
    `, [date]);

  if (previous?.lecture_number) {
    const seriesName = 'nodejs_120';
    const number = Number(previous.lecture_number) + 1;
    const lectureTitle = await getLectureTitle(number, seriesName).catch(() => null);
    return { number, seriesName, lectureTitle: lectureTitle || `제${number}강` };
  }

  const nextLecture = await getNextLectureNumber();
  const lectureTitle = await getLectureTitle(nextLecture.number, nextLecture.seriesName).catch(() => null);
  return {
    number: nextLecture.number,
    seriesName: nextLecture.seriesName,
    lectureTitle: lectureTitle || `제${nextLecture.number}강`,
  };
}

async function _resolveGeneralPlan(date = _today()) {
  const realToday = _realToday();
  const futurePrevious = date > realToday
    ? await pgPool.get('blog', `
      SELECT category
      FROM blog.publish_schedule
      WHERE post_type = 'general'
        AND publish_date < $1
        AND publish_date > $2
        AND category IS NOT NULL
      ORDER BY publish_date DESC, id DESC
      LIMIT 1
    `, [date, realToday])
    : null;

  const previous = futurePrevious?.category
    ? futurePrevious
    : await pgPool.get('blog', `
      SELECT category
      FROM blog.publish_schedule
      WHERE post_type = 'general'
        AND publish_date < $1
        AND category IS NOT NULL
      ORDER BY publish_date DESC, id DESC
      LIMIT 1
    `, [date]);

  if (previous?.category && futurePrevious?.category) {
    return { category: _nextGeneralCategoryFrom(previous.category) };
  }

  return getNextGeneralCategory().catch(() => ({ category: '자기계발' }));
}

async function getTodaySchedule() {
  return getScheduleByDate(_today());
}

async function getScheduleByDate(date) {
  try {
    await ensureBlogCoreSchema();
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

async function _repairExistingSchedule(date, rows = []) {
  if (!rows.length || DEV_HUB_READONLY) return rows;

  const lectureRow = rows.find((row) => row.post_type === 'lecture');
  const generalRow = rows.find((row) => row.post_type === 'general');
  const lecturePlan = await _resolveLecturePlan(date);
  const generalPlan = await _resolveGeneralPlan(date);

  if (
    lectureRow &&
    lectureRow.status === 'scheduled' &&
    !lectureRow.post_id &&
    (
      Number(lectureRow.lecture_number || 0) !== Number(lecturePlan.number) ||
      String(lectureRow.lecture_title || '').trim() !== String(lecturePlan.lectureTitle || '').trim()
    )
  ) {
    await pgPool.run('blog', `
      UPDATE blog.publish_schedule
      SET lecture_number = $1,
          lecture_title = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [lecturePlan.number, lecturePlan.lectureTitle, lectureRow.id]);
  }

  if (
    generalRow &&
    generalRow.status === 'scheduled' &&
    !generalRow.post_id &&
    String(generalRow.category || '').trim() !== String(generalPlan.category || '').trim()
  ) {
    await updateScheduleCategory(generalRow.id, generalPlan.category);
  }

  return getScheduleByDate(date);
}

async function ensureSchedule(date = _today()) {
  try {
    await ensureBlogCoreSchema();
    const existing = await getScheduleByDate(date);
    if (existing.length > 0) {
      return _repairExistingSchedule(date, existing);
    }

    const lecturePlan = await _resolveLecturePlan(date);
    const generalPlan = await _resolveGeneralPlan(date);

    if (DEV_HUB_READONLY) {
      console.log(`[스케줄] DEV/HUB 읽기 전용 — ${date} 합성 스케줄 사용 (${generalPlan.category})`);
      return _buildSyntheticSchedule(date);
    }

    await pgPool.run('blog', `
      INSERT INTO blog.publish_schedule (publish_date, post_type, lecture_number, lecture_title, category, status)
      VALUES
        ($1, 'lecture', $2, $3, 'Node.js강의', 'scheduled'),
        ($1, 'general', NULL, NULL, $4, 'scheduled')
      ON CONFLICT DO NOTHING
    `, [date, lecturePlan.number, lecturePlan.lectureTitle, generalPlan.category]);

    console.log(`[스케줄] ${date} 자동 생성 — 강의 ${lecturePlan.number}강 / 일반 카테고리: ${generalPlan.category}`);
    const created = await getScheduleByDate(date);
    return created.length > 0 ? created : _buildSyntheticSchedule(date);
  } catch (e) {
    if (_isDbPermissionError(e)) {
      console.log('[스케줄] DB 접근 제한 — 합성 스케줄 사용');
    } else {
      console.warn('[스케줄] 자동 생성 실패:', e.message);
    }
    return _buildSyntheticSchedule(date);
  }
}

async function resolveTestLecture() {
  const { number, seriesName } = await getNextLectureNumber();
  const testNum = Math.max(1, number - 2);
  const title = await getLectureTitle(testNum, seriesName);
  console.log(`[스케줄] 🧪 TEST 모드 — 강의 ${number} → ${testNum}강 (${title || '제목 없음'})`);
  return { number: testNum, seriesName, lectureTitle: title || `제${testNum}강` };
}

async function getTodayContext() {
  const schedule = await ensureSchedule();

  const lectureRow = schedule.find((r) => r.post_type === 'lecture') || null;
  const generalRow = schedule.find((r) => r.post_type === 'general') || null;

  const needLecture = lectureRow && isActionableScheduleStatus(lectureRow.status);
  const needGeneral = generalRow && isActionableScheduleStatus(generalRow.status);

  let lectureCtx = null;
  if (needLecture) {
    if (IS_TEST) {
      lectureCtx = await resolveTestLecture();
    } else {
      const seriesName = 'nodejs_120';
      const fallbackLecture = await _resolveLecturePlan(_today()).catch(() => ({ number: 1, lectureTitle: null, seriesName }));
      const number = Number(lectureRow.lecture_number || fallbackLecture.number);
      const planner = _getPlanner();
      const curriculumTitle = planner
        ? await planner.getNextLectureTitle(seriesName, number).catch(() => null)
        : null;
      const title = lectureRow.lecture_title
        || curriculumTitle
        || fallbackLecture.lectureTitle
        || (await getLectureTitle(number, seriesName))
        || `제${number}강`;
      lectureCtx = { number, seriesName, lectureTitle: title };
    }
  }

  let generalCtx = null;
  if (needGeneral) {
    const category = generalRow.category || (await getNextGeneralCategory()).category;
    generalCtx = {
      category,
      scheduleId: generalRow.id,
      bookInfo: {
        book_title: generalRow.book_title || null,
        book_author: generalRow.book_author || null,
        book_isbn: generalRow.book_isbn || null,
      },
      topicHint: generalRow.lecture_title || null,
    };
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
