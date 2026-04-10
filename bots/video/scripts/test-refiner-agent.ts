// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/index');
const { loadEDL } = require('../lib/edl-builder');
const { parseSrt } = require('../lib/critic-agent');
const { runRefiner, saveRefinerResult } = require('../lib/refiner-agent');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const CRITIC_REPORT_PATH = path.join(TEMP_DIR, 'critic_report.json');
const SUBTITLE_PATH = path.join(TEMP_DIR, 'subtitle_corrected.srt');
const EDL_PATH = path.join(TEMP_DIR, 'edit_decision_list.json');
const VIDEO_PATH = path.join(TEMP_DIR, 'synced.mp4');
const RESULT_PATH = path.join(TEMP_DIR, 'refiner_result.json');

function printChanges(label, changes, limit = 3) {
  console.log(`[test] ${label}: ${changes.length}건`);
  changes.slice(0, limit).forEach((change, index) => {
    console.log(`  ${index + 1}. ${JSON.stringify(change)}`);
  });
}

async function main() {
  const config = loadConfig();
  const result = await runRefiner(
    CRITIC_REPORT_PATH,
    SUBTITLE_PATH,
    EDL_PATH,
    config,
    { videoPath: VIDEO_PATH }
  );

  saveRefinerResult(result, RESULT_PATH);

  console.log(`[test] 자막 수정 건수: ${result.subtitle.changes_count}`);
  printChanges('자막 변경', result.subtitle.changes);
  console.log(`[test] EDL 수정 건수: ${result.edl.changes_count}`);
  printChanges('EDL 변경', result.edl.changes);
  console.log(`[test] 오디오 수정 여부: ${result.audio ? '수정됨' : '수정 없음'}`);
  console.log(`[test] 총 비용: $${Number(result.cost_usd || 0).toFixed(6)}`);
  console.log(`[test] refiner_result 저장: ${RESULT_PATH}`);

  if (!fs.existsSync(RESULT_PATH)) {
    throw new Error('refiner_result.json 파일이 생성되지 않았습니다.');
  }

  const refinedSubtitlePath = result.subtitle.path;
  const refinedEdlPath = result.edl.path;

  const refinedEntries = parseSrt(fs.readFileSync(refinedSubtitlePath, 'utf8'));
  if (!refinedEntries.length) {
    throw new Error('수정된 SRT를 다시 파싱하지 못했습니다.');
  }

  const refinedEdl = loadEDL(refinedEdlPath);
  if (!Array.isArray(refinedEdl.edits)) {
    throw new Error('수정된 EDL이 유효하지 않습니다.');
  }

  console.log(`[test] 수정된 SRT 파싱: ✅ ${refinedEntries.length} entries`);
  console.log(`[test] 수정된 EDL 로드: ✅ edits=${refinedEdl.edits.length}`);
  console.log('[test] 과제 11 Refiner Agent 테스트 완료!');
}

main().catch((error) => {
  console.error('[test] Refiner Agent 실패:', error.message);
  process.exit(1);
});
