// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/index');
const { runQualityLoop, saveLoopResult } = require('../lib/quality-loop');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const VIDEO_PATH = path.join(TEMP_DIR, 'synced.mp4');
const SUBTITLE_PATH = path.join(TEMP_DIR, 'subtitle_corrected.srt');
const EDL_PATH = path.join(TEMP_DIR, 'edit_decision_list.json');
const ANALYSIS_PATH = path.join(TEMP_DIR, 'analysis.json');
const LOOP_RESULT_PATH = path.join(TEMP_DIR, 'loop_result.json');

function printProgress(event) {
  if (event.type === 'critic_start') {
    console.log(`[test] critic 시작 (iteration=${event.iteration})`);
    return;
  }
  if (event.type === 'critic_done') {
    console.log(`[test] critic 완료 (iteration=${event.iteration}, score=${event.score})`);
    return;
  }
  if (event.type === 'refiner_start') {
    console.log(`[test] refiner 시작 (iteration=${event.iteration})`);
    return;
  }
  if (event.type === 'refiner_done') {
    console.log(`[test] refiner 완료 (iteration=${event.iteration}, changes=${event.changes})`);
    return;
  }
  if (event.type === 'evaluator_start') {
    console.log(`[test] evaluator 시작 (iteration=${event.iteration})`);
    return;
  }
  if (event.type === 'evaluator_done') {
    console.log(`[test] evaluator 완료 (iteration=${event.iteration}, score=${event.score}, recommendation=${event.recommendation})`);
    return;
  }
  if (event.type === 'loop_done') {
    console.log(`[test] loop 종료 (finalScore=${event.finalScore}, pass=${event.pass})`);
  }
}

async function main() {
  const config = loadConfig();
  config.quality_loop = {
    ...(config.quality_loop || {}),
    enabled: true,
  };

  const result = await runQualityLoop(
    VIDEO_PATH,
    SUBTITLE_PATH,
    EDL_PATH,
    ANALYSIS_PATH,
    config,
    {
      tempDir: TEMP_DIR,
      onProgress: printProgress,
    }
  );

  saveLoopResult(result, LOOP_RESULT_PATH);

  console.log(`[test] 반복 횟수: ${result.iterations_run}/${result.max_iterations}`);
  for (const item of result.history || []) {
    console.log(`[test] iteration=${item.iteration} score=${item.score} action=${item.action}`);
  }
  console.log(`[test] 최종 점수: ${result.final_score} (${result.pass ? 'PASS' : 'FAIL'})`);
  console.log(`[test] 최고 버전: ${JSON.stringify(result.best_version)}`);
  console.log(`[test] 총 비용: $${Number(result.total_cost_usd || 0).toFixed(6)}`);
  console.log(`[test] loop_result 저장: ${LOOP_RESULT_PATH}`);

  if (!fs.existsSync(LOOP_RESULT_PATH)) {
    throw new Error('loop_result.json 파일이 생성되지 않았습니다.');
  }
  if (!result.best_version?.subtitle_path || !fs.existsSync(result.best_version.subtitle_path)) {
    throw new Error('최고 버전 subtitle 경로가 유효하지 않습니다.');
  }
  if (!result.best_version?.edl_path || !fs.existsSync(result.best_version.edl_path)) {
    throw new Error('최고 버전 EDL 경로가 유효하지 않습니다.');
  }

  console.log('[test] 과제 12 Evaluator + Quality Loop 테스트 완료!');
}

main().catch((error) => {
  console.error('[test] Quality Loop 실패:', error.message);
  process.exit(1);
});
