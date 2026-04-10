// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../src/index');
const {
  healthCheck,
  createDraft,
  addVideo,
  addAudio,
  addSubtitle,
  saveDraft,
  findDraftFolder,
  copyToCapCut,
  buildDraft,
} = require('../lib/capcut-draft-builder');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const SYNCED_VIDEO = path.join(TEMP_DIR, 'synced.mp4');
const NARR_AUDIO = path.join(TEMP_DIR, 'narr_norm.m4a');
const SRT_PATH = path.join(TEMP_DIR, 'subtitle_corrected.srt');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  assert(fs.existsSync(SYNCED_VIDEO), `동기화 영상이 없습니다: ${SYNCED_VIDEO}`);
  assert(fs.existsSync(NARR_AUDIO), `정규화 오디오가 없습니다: ${NARR_AUDIO}`);
  assert(fs.existsSync(SRT_PATH), `교정 자막이 없습니다: ${SRT_PATH}`);

  const health = await healthCheck(config);
  assert(health.alive === true, 'CapCutAPI healthCheck 실패');
  console.log(`[test] healthCheck: ✅ alive (${health.latency_ms}ms)`);

  const created = await createDraft(config);
  assert(/^dfd_cat_/.test(created.draftId), `draftId 형식 이상: ${created.draftId}`);
  console.log(`[test] createDraft: ✅ draftId=${created.draftId}`);

  await addVideo(config, created.draftId, SYNCED_VIDEO, { volume: 0 });
  console.log('[test] addVideo: ✅ synced.mp4 추가');

  await addAudio(config, created.draftId, NARR_AUDIO);
  console.log('[test] addAudio: ✅ narr_norm.m4a 추가');

  const srtContent = fs.readFileSync(SRT_PATH, 'utf8');
  await addSubtitle(config, created.draftId, srtContent);
  console.log(`[test] addSubtitle: ✅ ${srtContent.split(/\n\s*\n/g).filter(Boolean).length} entries 추가`);

  const saveResult = await saveDraft(config, created.draftId);
  assert(saveResult.saved === true, 'saveDraft 실패');
  console.log('[test] saveDraft: ✅ 저장 요청 성공');

  const { draftPath } = findDraftFolder(config, created.draftId);
  assert(fs.existsSync(draftPath), `repo 내부 draft 폴더를 찾지 못했습니다: ${draftPath}`);
  console.log(`[test] findDraftFolder: ✅ ${draftPath}`);

  const copied = copyToCapCut(draftPath, config.paths.capcut_drafts);
  assert(fs.existsSync(copied.targetPath), `CapCut 프로젝트 폴더 복사 실패: ${copied.targetPath}`);
  console.log(`[test] copyToCapCut: ✅ ${copied.targetPath}`);

  const integrated = await buildDraft(
    config,
    SYNCED_VIDEO,
    NARR_AUDIO,
    SRT_PATH,
    'codex_capcut_build_draft'
  );
  assert(fs.existsSync(integrated.draftPath), `통합 draft 경로 누락: ${integrated.draftPath}`);
  assert(fs.existsSync(integrated.capCutPath), `통합 CapCut 복사 경로 누락: ${integrated.capCutPath}`);
  console.log('[test] buildDraft 통합: ✅ 전체 파이프라인 성공');

  console.log('[test] 과제 5 전체 통과!');
}

main().catch(error => {
  console.error('[test] 과제 5 실패:', error.message);
  process.exit(1);
});
