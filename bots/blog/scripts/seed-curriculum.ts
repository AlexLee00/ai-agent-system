#!/usr/bin/env node
'use strict';

/**
 * seed-curriculum.js — curriculum.txt → blog.curriculum 테이블 시딩
 *
 * 파싱 규칙:
 *   - "제N강:" 또는 "N강:" 패턴으로 강의 번호·제목 추출
 *   - "[N개월 차]" 패턴으로 month_chapter 결정
 *
 * 실행: node bots/blog/scripts/seed-curriculum.ts [--series=nodejs_120]
 */

const fs = require('fs');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');

const args = process.argv.slice(2);
const seriesArg = args.find((a) => a.startsWith('--series='))?.split('=')[1];
const SERIES = seriesArg || 'nodejs_120';

const CURRICULUM_FILE = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'context', 'curriculum.txt');

function parseCurriculum(text) {
  const lectures = [];
  let currentMonth = 1;

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const monthMatch = trimmed.match(/\[(\d+)개월\s*차/);
    if (monthMatch) {
      currentMonth = parseInt(monthMatch[1]);
      continue;
    }

    const lectureMatch = trimmed.match(/^(?:제)?(\d+)강[:\s.]+(.+)/);
    if (lectureMatch) {
      const num = parseInt(lectureMatch[1]);
      const title = lectureMatch[2].trim();
      if (num > 0 && title) {
        lectures.push({
          lecture_number: num,
          title,
          month_chapter: currentMonth,
        });
      }
      continue;
    }

    const numDotMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numDotMatch) {
      const num = parseInt(numDotMatch[1]);
      const title = numDotMatch[2].trim();
      if (num > 0 && num <= 200 && title) {
        lectures.push({
          lecture_number: num,
          title,
          month_chapter: currentMonth,
        });
      }
    }
  }

  return lectures;
}

async function main() {
  if (!fs.existsSync(CURRICULUM_FILE)) {
    console.error(`❌ 커리큘럼 파일 없음: ${CURRICULUM_FILE}`);
    console.error('   context/curriculum.txt에 커리큘럼을 저장하세요.');
    process.exit(1);
  }

  const text = fs.readFileSync(CURRICULUM_FILE, 'utf8');
  const lectures = parseCurriculum(text);

  if (lectures.length === 0) {
    console.error('❌ 파싱된 강의 없음. curriculum.txt 형식을 확인하세요.');
    process.exit(1);
  }

  console.log(`파싱 완료: ${lectures.length}강 (시리즈: ${SERIES})`);
  console.log('샘플:', lectures.slice(0, 3).map((l) => `${l.lecture_number}강: ${l.title}`).join(', '));

  let inserted = 0;
  for (const lec of lectures) {
    try {
      await pgPool.run('blog', `
        INSERT INTO blog.curriculum (series_name, lecture_number, title, month_chapter)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (series_name, lecture_number) DO UPDATE
          SET title = EXCLUDED.title, month_chapter = EXCLUDED.month_chapter
      `, [SERIES, lec.lecture_number, lec.title, lec.month_chapter]);
      inserted++;
    } catch (e) {
      console.warn(`  [${lec.lecture_number}강] 저장 실패:`, e.message);
    }
  }

  console.log(`✅ 완료: ${inserted}/${lectures.length}강 저장됨 (시리즈: ${SERIES})`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ 시딩 실패:', e.message);
  process.exit(1);
});
