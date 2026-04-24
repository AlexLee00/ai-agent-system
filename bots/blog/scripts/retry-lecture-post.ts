'use strict';

const { retryLectureOnly } = require('../lib/blo.ts');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

retryLectureOnly({ dryRun })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error('[블로] 강의 포스팅 재발행 실패:', error?.message || error);
    process.exit(1);
  });
