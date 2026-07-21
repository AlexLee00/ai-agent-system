#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BLOG_WRITER_ROTATION_POLICY,
  DEFAULT_BLOG_WRITER_MODEL,
  isRotationExperimentAssignment,
  resolveBlogWriterAssignment,
  resolveBlogWriterModelForAssignment,
} = require('../lib/writer-model-policy.ts');
const { _testOnly: bloTest } = require('../lib/blo.ts');

function assignment(publishDate: string | Date, postType: string, env = {}) {
  return resolveBlogWriterAssignment({ publishDate, postType }, env);
}

function main() {
  const boundaries = [];
  const dayOneLecture = assignment('2026-07-21', 'lecture');
  const dayOneGeneral = assignment('2026-07-21', 'general');
  assert.notEqual(dayOneLecture.model, dayOneGeneral.model);
  boundaries.push('same-day-opposite-models');

  const dayTwoLecture = assignment('2026-07-22', 'lecture');
  const dayTwoGeneral = assignment('2026-07-22', 'general');
  assert.equal(dayTwoLecture.model, dayOneGeneral.model);
  assert.equal(dayTwoGeneral.model, dayOneLecture.model);
  boundaries.push('next-day-stratum-flip');

  const sevenDays = Array.from({ length: 7 }, (_, offset) => {
    const date = `2026-07-${String(21 + offset).padStart(2, '0')}`;
    return [assignment(date, 'lecture'), assignment(date, 'general')];
  }).flat();
  assert.equal(sevenDays.filter((item) => item.model === 'anthropic_sonnet').length, 7);
  assert.equal(sevenDays.filter((item) => item.model === 'anthropic_haiku').length, 7);
  boundaries.push('seven-day-fifty-fifty');

  const replayed = assignment('2026-07-22', 'lecture');
  assert.deepEqual(replayed, dayTwoLecture);
  assert.equal(replayed.tag, dayTwoLecture.tag);
  boundaries.push('retry-order-determinism');

  const fixedHaiku = assignment('2026-07-21', 'lecture', { BLOG_WRITER_MODEL: 'anthropic_haiku' });
  const fixedSonnet = assignment('2026-07-21', 'general', { BLOG_WRITER_MODEL: 'anthropic_sonnet' });
  assert.equal(fixedHaiku.model, 'anthropic_haiku');
  assert.equal(fixedSonnet.model, 'anthropic_sonnet');
  assert.equal(fixedHaiku.source, 'env_override');
  assert.equal(fixedSonnet.source, 'env_override');
  boundaries.push('one-line-env-rollback');

  const missingIdentity = resolveBlogWriterAssignment({}, {});
  const invalidIdentity = assignment('not-a-date', 'other');
  const overflowIdentity = assignment('2026-02-31', 'lecture');
  const kstDateAssignment = assignment(new Date('2026-07-21T00:30:00+09:00'), 'lecture');
  assert.equal(missingIdentity.model, DEFAULT_BLOG_WRITER_MODEL);
  assert.equal(invalidIdentity.model, DEFAULT_BLOG_WRITER_MODEL);
  assert.equal(overflowIdentity.source, 'identity_fallback');
  assert.deepEqual(kstDateAssignment, dayOneLecture);
  assert.equal(missingIdentity.source, 'identity_fallback');
  boundaries.push('missing-invalid-identity-fallback');

  assert.equal(Object.isFrozen(dayOneLecture), true);
  const frozenModel = dayOneLecture.model;
  try { dayOneLecture.model = 'anthropic_haiku'; } catch {}
  assert.equal(dayOneLecture.model, frozenModel);
  boundaries.push('immutable-assignment');

  for (const stage of ['single', 'chunked', 'repair']) {
    assert.equal(resolveBlogWriterModelForAssignment(dayOneLecture, { BLOG_WRITER_MODEL: 'ignored_after_assignment' }), dayOneLecture.model, stage);
  }
  const metadata = bloTest.buildWriterAbMetadata({
    writerModel: dayOneLecture.model,
    writerModelAssignment: dayOneLecture,
  });
  assert.deepEqual(metadata.writer_model_assignment, dayOneLecture);
  boundaries.push('writer-stage-and-metadata-propagation');

  assert.equal(isRotationExperimentAssignment(dayOneLecture), true);
  assert.equal(isRotationExperimentAssignment(fixedHaiku), false);
  assert.equal(isRotationExperimentAssignment(missingIdentity), false);
  const bloSource = fs.readFileSync(path.resolve(__dirname, '../lib/blo.ts'), 'utf8');
  const posSource = fs.readFileSync(path.resolve(__dirname, '../lib/pos-writer.ts'), 'utf8');
  const gemsSource = fs.readFileSync(path.resolve(__dirname, '../lib/gems-writer.ts'), 'utf8');
  assert.ok(bloSource.includes('writerModelAssignment'));
  assert.ok(posSource.includes('resolveBlogWriterModelForAssignment'));
  assert.ok(gemsSource.includes('resolveBlogWriterModelForAssignment'));
  assert.match(bloSource, /buildSingleArgs:[^\n]+writerModelAssignment/);
  assert.match(bloSource, /buildChunkedArgs:[^\n]+writerModelAssignment/);
  assert.match(bloSource, /buildRepairArgs:[\s\S]+?writerModelAssignment/);
  assert.match(posSource, /writeLecturePostChunked\([^\n]+writerModelAssignment\)/);
  const lectureFinalizer = bloSource.slice(
    bloSource.indexOf('async function _finalizeLecturePost'),
    bloSource.indexOf('async function _finalizeGeneralPost'),
  );
  assert.doesNotMatch(lectureFinalizer, /runTitleFeedbackLoop|_applyGeneralTitleFeedback/);
  boundaries.push('rotation-only-analysis-and-pipeline-wiring');

  assert.equal(boundaries.length, 9);
  assert.equal(BLOG_WRITER_ROTATION_POLICY, 'daily-post-type-checkerboard-v1');
  console.log(JSON.stringify({
    ok: true,
    suite: 'writer-model-rotation',
    boundaries,
    policy: BLOG_WRITER_ROTATION_POLICY,
    dayOne: [dayOneLecture, dayOneGeneral],
    dayTwo: [dayTwoLecture, dayTwoGeneral],
    modelCounts: {
      anthropic_sonnet: sevenDays.filter((item) => item.model === 'anthropic_sonnet').length,
      anthropic_haiku: sevenDays.filter((item) => item.model === 'anthropic_haiku').length,
    },
  }, null, 2));
}

main();
