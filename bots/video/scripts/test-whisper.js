'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../src/index');
const {
  transcribe,
  toSRT,
  generateSubtitle,
} = require('../lib/whisper-client');

const SAMPLE_AUDIO = path.join(__dirname, '..', 'samples', 'narration', '원본_나레이션_파라미터.m4a');
const OUTPUT_SRT = path.join(__dirname, '..', 'temp', 'subtitle_raw.srt');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isValidSrtTimestamp(text) {
  return /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/m.test(text);
}

async function main() {
  const transcribeStartedAt = Date.now();
  const transcribed = await transcribe(SAMPLE_AUDIO, config);
  assert(Array.isArray(transcribed.segments), 'segments 배열이 아닙니다.');
  assert(transcribed.segments.length > 0, 'segments가 비어 있습니다.');
  assert(
    transcribed.segments.every(segment =>
      typeof segment.start === 'number' &&
      typeof segment.end === 'number' &&
      typeof segment.text === 'string'
    ),
    'segment 구조가 유효하지 않습니다.'
  );
  console.log(`[test] transcribe: ✅ (${Date.now() - transcribeStartedAt}ms) → ${transcribed.segments.length} segments`);

  const srt = toSRT(transcribed.segments);
  assert(srt.startsWith('1\n'), 'SRT가 "1\\n"으로 시작하지 않습니다.');
  assert(isValidSrtTimestamp(srt), 'SRT 타임스탬프 형식이 유효하지 않습니다.');
  console.log(`[test] toSRT: ✅ → 유효한 SRT (${transcribed.segments.length} entries)`);

  if (fs.existsSync(OUTPUT_SRT)) {
    fs.unlinkSync(OUTPUT_SRT);
  }

  const generated = await generateSubtitle(SAMPLE_AUDIO, OUTPUT_SRT, config);
  assert(fs.existsSync(OUTPUT_SRT), 'subtitle_raw.srt 파일이 생성되지 않았습니다.');
  const stats = fs.statSync(OUTPUT_SRT);
  assert(stats.size > 0, 'subtitle_raw.srt 파일 크기가 0입니다.');

  const saved = fs.readFileSync(OUTPUT_SRT, 'utf8');
  assert(/[가-힣]/.test(saved), '한국어 텍스트가 포함되지 않았습니다.');
  assert(isValidSrtTimestamp(saved), '저장된 SRT의 타임스탬프 형식이 유효하지 않습니다.');

  console.log(`[test] generateSubtitle: ✅ → temp/subtitle_raw.srt (${(stats.size / 1024).toFixed(1)}KB)`);
  console.log(`[test] 비용: $${generated.cost.toFixed(3)}`);
  console.log(`[test] SRT 샘플: ${JSON.stringify(saved.split('\n').slice(0, 3).join('\\n'))}`);
  console.log('[test] 과제 3 전체 통과!');
}

main().catch(err => {
  console.error('[test] 과제 3 실패:', err.message);
  process.exit(1);
});
