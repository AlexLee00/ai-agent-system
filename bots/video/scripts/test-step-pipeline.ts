// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/index');
const {
  generateSteps,
  attachRedEvaluation,
  attachBlueAlternative,
  stepsToSyncMap,
} = require('../lib/step-proposal-engine');
const { syncMapToEDL } = require('../lib/sync-matcher');

const TEMP_ROOT = path.join(__dirname, '..', 'temp');

function findLatestRunDir() {
  if (!fs.existsSync(TEMP_ROOT)) return null;
  const entries = fs.readdirSync(TEMP_ROOT)
    .filter((name) => name.startsWith('run-'))
    .map((name) => ({
      name,
      fullPath: path.join(TEMP_ROOT, name),
      mtimeMs: fs.statSync(path.join(TEMP_ROOT, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.fullPath || null;
}

function buildDummyFixture() {
  return {
    syncMap: {
      total_segments: 2,
      matched_keyword: 1,
      matched_embedding: 1,
      matched_hold: 0,
      unmatched: 0,
      overall_confidence: 0.73,
      matches: [
        {
          segment_id: 'seg_001',
          narration: { start_s: 0, end_s: 18, topic: 'FlutterFlow 소개' },
          source: { frame_id: 'frame_001', start_s: 0, end_s: 60, description: '앱 빌더 UI', scene_type: 'ui_overview' },
          match_type: 'keyword',
          match_score: 0.85,
          overlap_keywords: ['FlutterFlow', '앱'],
          speed_factor: 0.45,
          confidence: 'high',
          hold_from_segment_id: null,
          narration_start_s: 0,
          narration_end_s: 18,
        },
        {
          segment_id: 'seg_002',
          narration: { start_s: 18, end_s: 42, topic: '배포 방법' },
          source: { frame_id: 'frame_004', start_s: 61, end_s: 130, description: '배포 설정 화면', scene_type: 'settings' },
          match_type: 'embedding',
          match_score: 0.61,
          overlap_keywords: ['배포'],
          speed_factor: 0.52,
          confidence: 'medium',
          hold_from_segment_id: null,
          narration_start_s: 18,
          narration_end_s: 42,
        },
      ],
    },
    sceneIndex: {
      scenes: [
        { frame_id: 'frame_010', timestamp_s: 140, timestamp_end_s: 200, description: '템플릿 갤러리', scene_type: 'gallery' },
        { frame_id: 'frame_011', timestamp_s: 201, timestamp_end_s: 250, description: '배포 미리보기', scene_type: 'preview' },
      ],
    },
    sourceVideoPath: path.join(TEMP_ROOT, 'dummy_source.mp4'),
    narrationAudioPath: path.join(TEMP_ROOT, 'dummy_narration.m4a'),
  };
}

function loadFixture() {
  const latestRunDir = findLatestRunDir();
  if (!latestRunDir) return buildDummyFixture();

  const syncMapPath = path.join(latestRunDir, 'sync_map.json');
  const sceneIndexPath = path.join(latestRunDir, 'scene_index.json');
  const narrationAudioPath = path.join(latestRunDir, 'narr_norm.m4a');
  const sourceVideoPath = path.join(latestRunDir, 'source.mp4');

  if (!fs.existsSync(syncMapPath)) return buildDummyFixture();

  return {
    syncMap: JSON.parse(fs.readFileSync(syncMapPath, 'utf8')),
    sceneIndex: fs.existsSync(sceneIndexPath)
      ? JSON.parse(fs.readFileSync(sceneIndexPath, 'utf8'))
      : { scenes: [] },
    sourceVideoPath,
    narrationAudioPath,
  };
}

async function main() {
  const config = loadConfig();
  const fixture = loadFixture();

  const steps = generateSteps(fixture.syncMap, config, {});
  const withRed = await attachRedEvaluation(steps, {
    ...config,
    step_proposal: {
      ...(config.step_proposal || {}),
      red_required_below: 0,
    },
  });
  const withBlue = await attachBlueAlternative(withRed, fixture.sceneIndex, config);

  withBlue.forEach((step) => {
    if (!step.user_action) {
      step.user_action = step.blue ? 'adopt_blue' : 'confirm';
      step.final = step.blue?.alternative_source
        ? {
            ...step.proposal,
            source: step.blue.alternative_source,
            match_type: step.blue.match_type || step.proposal.match_type,
            match_score: Number(step.blue.match_score || step.proposal.match_score || 0),
            reason: step.blue.reason || step.proposal.reason,
          }
        : step.proposal;
    }
  });

  const rebuiltSyncMap = stepsToSyncMap(withBlue);
  const edl = syncMapToEDL(
    rebuiltSyncMap,
    fixture.sourceVideoPath,
    fixture.narrationAudioPath,
    null,
    null,
    config
  );

  const summary = {
    totalSteps: withBlue.length,
    autoConfirmCount: withBlue.filter((step) => step.auto_confirm).length,
    redEvaluatedCount: withBlue.filter((step) => step.red !== null).length,
    blueSuggestedCount: withBlue.filter((step) => step.blue !== null).length,
    originalMatches: fixture.syncMap.matches.length,
    rebuiltMatches: rebuiltSyncMap.matches.length,
    edlClipCount: Array.isArray(edl.clips) ? edl.clips.length : 0,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
