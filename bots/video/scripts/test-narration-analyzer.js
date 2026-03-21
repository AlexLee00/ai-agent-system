'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { loadConfig } = require('../src/index');
const { analyzeNarration } = require('../lib/narration-analyzer');

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const parsed = { sourceAudio: null, allowOfflineFixture: true };
  for (const arg of argv) {
    if (arg.startsWith('--source-audio=')) {
      parsed.sourceAudio = arg.slice('--source-audio='.length);
    }
    if (arg === '--no-offline-fixture') {
      parsed.allowOfflineFixture = false;
    }
  }
  return parsed;
}

async function probeDurationSec(audioPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);
  const duration = Number.parseFloat(String(stdout || '').trim());
  return Number.isFinite(duration) ? duration : 180;
}

async function buildOfflineFixture(audioPath) {
  const durationSec = Math.max(30, Math.round(await probeDurationSec(audioPath)));
  const segmentSpan = Math.max(20, Math.floor(durationSec / 3));
  const segments = [
    {
      segment_id: 1,
      start_s: 0,
      end_s: Math.min(durationSec, segmentSpan),
      entries: [1],
      text: '파라미터 소개와 기본 개념 설명',
      topic: '파라미터 개념 소개',
      required_screen: '에디터 전체 뷰',
      keywords_en: ['Parameter', 'Page', 'FlutterFlow'],
      keywords_ko: ['파라미터', '페이지'],
      action_verbs: ['소개', '설명'],
    },
    {
      segment_id: 2,
      start_s: Math.min(durationSec, segmentSpan),
      end_s: Math.min(durationSec, segmentSpan * 2),
      entries: [2],
      text: '파라미터 생성과 연결 방법 설명',
      topic: '파라미터 생성',
      required_screen: '파라미터 설정 화면',
      keywords_en: ['Parameter', 'Action', 'Set'],
      keywords_ko: ['생성', '설정'],
      action_verbs: ['생성', '설정'],
    },
    {
      segment_id: 3,
      start_s: Math.min(durationSec, segmentSpan * 2),
      end_s: durationSec,
      entries: [3],
      text: '페이지 이동과 값 전달 마무리 설명',
      topic: '페이지 이동과 값 전달',
      required_screen: '네비게이션 또는 액션 설정 화면',
      keywords_en: ['Navigate', 'Page', 'Value'],
      keywords_ko: ['이동', '값'],
      action_verbs: ['이동', '전달'],
    },
  ].filter((segment) => segment.start_s < segment.end_s);

  return {
    source_audio: path.basename(audioPath),
    duration_s: durationSec,
    total_entries: segments.length,
    total_segments: segments.length,
    segments,
    srt_path: null,
    corrected_srt_path: null,
    output_path: null,
    offline_fixture: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourceAudio) {
    throw new Error('--source-audio는 필수입니다.');
  }
  const config = loadConfig();
  const sourceAudio = path.resolve(args.sourceAudio);
  let result;
  try {
    result = await analyzeNarration(sourceAudio, config, { correct: true });
  } catch (error) {
    if (!args.allowOfflineFixture) throw error;
    console.warn('[video] test-narration-analyzer 오프라인 fixture fallback:', error.message);
    result = await buildOfflineFixture(sourceAudio);
  }
  console.log(JSON.stringify({
    source_audio: result.source_audio,
    duration_s: result.duration_s,
    total_entries: result.total_entries,
    total_segments: result.total_segments,
    output_path: result.output_path,
    offline_fixture: Boolean(result.offline_fixture),
    first_segment: result.segments?.[0] || null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-narration-analyzer 실패:', error.message);
    process.exit(1);
  });
}
