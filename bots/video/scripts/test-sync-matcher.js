'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/index');
const { buildSyncMap, syncMapToEDL } = require('../lib/sync-matcher');

function parseArgs(argv) {
  const parsed = {
    sceneIndex: null,
    narrationSegments: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--scene-index=')) parsed.sceneIndex = arg.slice('--scene-index='.length);
    if (arg.startsWith('--narration-segments=')) parsed.narrationSegments = arg.slice('--narration-segments='.length);
  }
  return parsed;
}

function buildDummySceneIndex() {
  return {
    output_path: process.cwd(),
    scenes: [
      {
        frame_id: 1,
        timestamp_s: 0,
        timestamp_end_s: 20,
        description: 'FlutterFlow editor overview',
        scene_type: 'editor_overview',
        keywords_en: ['FlutterFlow', 'Widget', 'Tree', 'Canvas', 'Parameter'],
        keywords_ko: ['플러터플로우', '위젯 트리'],
      },
      {
        frame_id: 2,
        timestamp_s: 20,
        timestamp_end_s: 45,
        description: 'Parameter panel on page settings',
        scene_type: 'parameter_panel',
        keywords_en: ['Parameter', 'Page', 'Navigate'],
        keywords_ko: ['파라미터', '페이지'],
      },
    ],
  };
}

function buildDummyNarration() {
  return {
    segments: [
      {
        segment_id: 1,
        start_s: 0,
        end_s: 25,
        topic: '파라미터 개념 소개',
        required_screen: '에디터 전체 화면',
        keywords_en: ['FlutterFlow', 'Parameter', 'Page'],
        keywords_ko: ['파라미터'],
        action_verbs: ['설정'],
      },
      {
        segment_id: 2,
        start_s: 25,
        end_s: 55,
        topic: '페이지 이동 시 파라미터 전달',
        required_screen: '파라미터 설정 화면',
        keywords_en: ['Navigate', 'Page', 'Parameter'],
        keywords_ko: ['페이지', '파라미터'],
        action_verbs: ['클릭'],
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const sceneIndex = args.sceneIndex
    ? JSON.parse(fs.readFileSync(path.resolve(args.sceneIndex), 'utf8'))
    : buildDummySceneIndex();
  const narration = args.narrationSegments
    ? JSON.parse(fs.readFileSync(path.resolve(args.narrationSegments), 'utf8'))
    : buildDummyNarration();

  const syncMap = await buildSyncMap(sceneIndex, narration, config, { tempDir: process.cwd() });
  const edl = syncMapToEDL(syncMap, '/tmp/source.mp4', '/tmp/narration.m4a', null, null, config);
  console.log(JSON.stringify({
    total_segments: syncMap.total_segments,
    matched_keyword: syncMap.matched_keyword,
    matched_embedding: syncMap.matched_embedding,
    matched_hold: syncMap.matched_hold,
    unmatched: syncMap.unmatched,
    overall_confidence: syncMap.overall_confidence,
    edl_clip_count: edl.clips?.length || 0,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-sync-matcher 실패:', error.message);
    process.exit(1);
  });
}
