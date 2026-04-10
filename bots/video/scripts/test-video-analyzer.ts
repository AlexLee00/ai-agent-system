// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../src/index');
const { analyzeVideo, saveAnalysis } = require('../lib/video-analyzer');

const VIDEO_PATH = path.join(__dirname, '..', 'temp', 'synced.mp4');
const ANALYSIS_PATH = path.join(__dirname, '..', 'temp', 'analysis.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function printSample(label, items, formatter) {
  console.log(`[test] ${label}: ${items.length}건`);
  items.slice(0, 3).forEach((item, index) => {
    console.log(`  ${index + 1}. ${formatter(item)}`);
  });
}

async function main() {
  const analysis = await analyzeVideo(VIDEO_PATH, config);

  assert(Number.isFinite(analysis.duration) && analysis.duration > 0, 'duration 정보를 찾을 수 없습니다.');
  assert(analysis.metadata.width > 0 && analysis.metadata.height > 0, '메타데이터 width/height를 찾을 수 없습니다.');

  printSample('무음 구간', analysis.silences, item => `${item.from.toFixed(2)}s ~ ${item.to.toFixed(2)}s (${item.duration.toFixed(2)}s)`);
  printSample('정지 화면', analysis.freezes, item => `${item.from.toFixed(2)}s ~ ${item.to.toFixed(2)}s (${item.duration.toFixed(2)}s)`);
  printSample('씬 전환', analysis.scenes, item => `${item.at.toFixed(2)}s (score=${item.score.toFixed(3)})`);
  console.log('[test] 메타데이터:', analysis.metadata);

  saveAnalysis(analysis, ANALYSIS_PATH);
  assert(fs.existsSync(ANALYSIS_PATH), 'analysis.json 저장 실패');

  console.log(`[test] analysis 저장: ✅ ${ANALYSIS_PATH}`);
  console.log('[test] 과제 6 video-analyzer 통과!');
}

main().catch(err => {
  console.error('[test] video-analyzer 실패:', err.message);
  process.exit(1);
});
