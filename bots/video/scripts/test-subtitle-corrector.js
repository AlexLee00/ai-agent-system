'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../src/index');
const {
  correctSubtitle,
  correctFile,
  splitSrtEntries,
  extractTimestampLines,
} = require('../lib/subtitle-corrector');

const INPUT_PATH = path.join(__dirname, '..', 'temp', 'subtitle_raw.srt');
const OUTPUT_PATH = path.join(__dirname, '..', 'temp', 'subtitle_corrected.srt');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function collectDiffSamples(beforeText, afterText, limit = 3) {
  const beforeEntries = splitSrtEntries(beforeText);
  const afterEntries = splitSrtEntries(afterText);
  const samples = [];

  for (let i = 0; i < Math.min(beforeEntries.length, afterEntries.length); i += 1) {
    if (beforeEntries[i] !== afterEntries[i]) {
      const beforeLines = beforeEntries[i].split('\n');
      const afterLines = afterEntries[i].split('\n');
      samples.push({
        before: beforeLines.slice(2).join(' '),
        after: afterLines.slice(2).join(' '),
      });
    }
    if (samples.length >= limit) break;
  }
  return samples;
}

async function main() {
  const originalSrt = fs.readFileSync(INPUT_PATH, 'utf8');
  const originalEntries = splitSrtEntries(originalSrt);
  const originalTimestamps = extractTimestampLines(originalSrt);

  const startedAt = Date.now();
  const corrected = await correctSubtitle(originalSrt, config);
  const correctedEntries = splitSrtEntries(corrected.correctedSrt);
  const correctedTimestamps = extractTimestampLines(corrected.correctedSrt);

  assert(correctedEntries.length === originalEntries.length, `entries 수 불일치: ${originalEntries.length} vs ${correctedEntries.length}`);
  console.log(`[test] correctSubtitle: ✅ (${Date.now() - startedAt}ms) → ${correctedEntries.length} entries 유지`);

  assert(correctedTimestamps.length === originalTimestamps.length, '타임스탬프 라인 수가 변경되었습니다.');
  assert(correctedTimestamps.every((line, index) => line === originalTimestamps[index]), '타임스탬프 라인이 변경되었습니다.');
  console.log(`[test] 타임스탬프 보존: ✅ (${correctedTimestamps.length}/${originalTimestamps.length} 일치)`);

  if (fs.existsSync(OUTPUT_PATH)) {
    fs.unlinkSync(OUTPUT_PATH);
  }

  const fileResult = await correctFile(INPUT_PATH, OUTPUT_PATH, config);
  assert(fs.existsSync(OUTPUT_PATH), 'subtitle_corrected.srt 파일이 생성되지 않았습니다.');
  const outputStats = fs.statSync(OUTPUT_PATH);
  assert(outputStats.size > 0, 'subtitle_corrected.srt 파일 크기가 0입니다.');
  console.log(`[test] correctFile: ✅ → temp/subtitle_corrected.srt (${(outputStats.size / 1024).toFixed(1)}KB)`);

  const savedSrt = fs.readFileSync(OUTPUT_PATH, 'utf8');
  const diffSamples = collectDiffSamples(originalSrt, savedSrt, 3);
  const diffCount = splitSrtEntries(originalSrt).filter((entry, index) => entry !== splitSrtEntries(savedSrt)[index]).length;
  console.log(`[test] 교정 변경: ${diffCount}곳 감지`);
  console.log('[test] 교정 샘플:');
  if (diffSamples.length === 0) {
    console.log('  - 변경 없음 (원문 유지)');
  } else {
    for (const sample of diffSamples) {
      console.log(`  - ${JSON.stringify(sample.before)} → ${JSON.stringify(sample.after)}`);
    }
  }

  const savedTimestamps = extractTimestampLines(savedSrt);
  assert(savedTimestamps.length === originalTimestamps.length, '저장된 교정본 타임스탬프 수가 다릅니다.');
  assert(savedTimestamps.every((line, index) => line === originalTimestamps[index]), '저장된 교정본 타임스탬프가 변경되었습니다.');

  assert(corrected.stats.cost <= 0.01, `비용이 목표를 초과했습니다: $${corrected.stats.cost}`);
  console.log(`[test] 비용: $${corrected.stats.cost.toFixed(3)} (${corrected.stats.provider})`);
  console.log('[test] 과제 4 전체 통과!');

  return fileResult;
}

main().catch(err => {
  console.error('[test] 과제 4 실패:', err.message);
  process.exit(1);
});
