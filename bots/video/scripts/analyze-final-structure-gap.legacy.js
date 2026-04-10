'use strict';

const fs = require('fs');
const path = require('path');

const { compareVideos } = require('../lib/reference-quality');
const { SAMPLE_MAP } = require('./test-reference-quality');

function parseArgs(argv) {
  const parsed = {
    generated: null,
    edl: null,
    reference: null,
    sample: null,
    json: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--generated=')) parsed.generated = arg.slice('--generated='.length);
    if (arg.startsWith('--edl=')) parsed.edl = arg.slice('--edl='.length);
    if (arg.startsWith('--reference=')) parsed.reference = arg.slice('--reference='.length);
    if (arg.startsWith('--sample=')) parsed.sample = arg.slice('--sample='.length);
    if (arg === '--json') parsed.json = true;
  }

  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveReferencePath(args) {
  if (args.reference) return path.resolve(args.reference);
  if (!args.sample) return null;
  const sample = SAMPLE_MAP[String(args.sample).trim()];
  return sample?.reference || null;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 3) {
  return Number(safeNumber(value, 0).toFixed(digits));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clipSourceDuration(clip) {
  return Math.max(0, safeNumber(clip?.source_end) - safeNumber(clip?.source_start));
}

function clipTimelineDuration(clip) {
  return Math.max(0, safeNumber(clip?.timeline_end) - safeNumber(clip?.timeline_start));
}

function summarizeEdl(edl) {
  const clips = Array.isArray(edl?.clips) ? edl.clips : [];
  const mainClips = clips.filter((clip) => clip.source_id === 'main');
  const holdClips = mainClips.filter((clip) => clip.match_type === 'hold');
  const speedFloorClips = mainClips.filter((clip) => safeNumber(clip.speed, 1) <= 0.5001);

  const grouped = new Map();
  for (const clip of mainClips) {
    const key = `${clip.source_id}:${clip.source_start}:${clip.source_end}`;
    const sourceDuration = clipSourceDuration(clip);
    const timelineDuration = clipTimelineDuration(clip);
    const current = grouped.get(key) || {
      key,
      source_start: safeNumber(clip.source_start),
      source_end: safeNumber(clip.source_end),
      source_duration_sec: round(sourceDuration),
      count: 0,
      timeline_total_sec: 0,
      segment_ids: [],
      speed_values: [],
      match_types: new Set(),
    };
    current.count += 1;
    current.timeline_total_sec += timelineDuration;
    current.segment_ids.push(clip.segment_id);
    current.speed_values.push(round(clip.speed, 4));
    current.match_types.add(String(clip.match_type || 'unknown'));
    grouped.set(key, current);
  }

  const repeatedWindows = [...grouped.values()]
    .filter((item) => item.count > 1)
    .map((item) => ({
      key: item.key,
      source_start: item.source_start,
      source_end: item.source_end,
      source_duration_sec: item.source_duration_sec,
      count: item.count,
      timeline_total_sec: round(item.timeline_total_sec),
      segment_ids: item.segment_ids,
      speed_values: item.speed_values,
      match_types: [...item.match_types],
    }))
    .sort((a, b) => b.count - a.count || b.timeline_total_sec - a.timeline_total_sec);

  const repeatedShortWindows = repeatedWindows.filter((item) => item.source_duration_sec <= 30);
  const generatedTimelineSec = round(safeNumber(edl?.duration));
  const mainTimelineSec = round(mainClips.reduce((sum, clip) => sum + clipTimelineDuration(clip), 0));

  return {
    clip_count: clips.length,
    main_clip_count: mainClips.length,
    hold_clip_count: holdClips.length,
    speed_floor_clip_count: speedFloorClips.length,
    speed_floor_ratio: mainClips.length ? round(speedFloorClips.length / mainClips.length, 4) : 0,
    generated_timeline_sec: generatedTimelineSec,
    main_timeline_sec: mainTimelineSec,
    repeated_window_count: repeatedWindows.length,
    repeated_short_window_count: repeatedShortWindows.length,
    repeated_windows_top3: repeatedWindows.slice(0, 3),
  };
}

function buildFindings(comparison, edlSummary) {
  const findings = [];
  const durationRatio = safeNumber(comparison.generated.durationSec) / Math.max(safeNumber(comparison.reference.durationSec), 1);

  if (durationRatio < 0.5) {
    findings.push('사람 편집본 대비 최종 길이가 절반 이하라 길이/구조 압축이 크다.');
  }
  if (edlSummary.speed_floor_ratio >= 0.6) {
    findings.push('main clip의 과반이 speed floor(0.5)에 걸려 있어 짧은 장면을 hold/tpad로 늘려 쓰는 경향이 강하다.');
  }
  if (edlSummary.repeated_short_window_count >= 1) {
    findings.push('같은 짧은 source window를 여러 segment에서 재사용하고 있어 장면 다양성이 부족하다.');
  }
  if (edlSummary.hold_clip_count >= 1) {
    findings.push('hold clip이 포함되어 있어 실제 장면 매칭보다 유지 전략에 기대는 구간이 있다.');
  }
  if (!findings.length) {
    findings.push('구조 병목이 크지 않거나, 현재 지표만으로는 뚜렷한 구조 경계를 찾지 못했다.');
  }
  return findings;
}

function printReport(sampleName, comparison, edlSummary, findings) {
  const durationRatio = round(safeNumber(comparison.generated.durationSec) / Math.max(safeNumber(comparison.reference.durationSec), 1), 3);
  console.log(`[final-structure-gap] sample=${sampleName || 'custom'}`);
  console.log(`[final-structure-gap] generated=${comparison.generated.path}`);
  console.log(`[final-structure-gap] reference=${comparison.reference.path}`);
  console.log(`[final-structure-gap] generated_sec=${comparison.generated.durationSec} reference_sec=${comparison.reference.durationSec} ratio=${durationRatio} delta=${comparison.deltas.durationSec}`);
  console.log(`[final-structure-gap] overall=${comparison.scores.overall} duration=${comparison.scores.duration} visual=${comparison.scores.visual_similarity} resolution=${comparison.scores.resolution}`);
  console.log(`[final-structure-gap] clips=${edlSummary.clip_count} main=${edlSummary.main_clip_count} hold=${edlSummary.hold_clip_count} speed_floor=${edlSummary.speed_floor_clip_count} speed_floor_ratio=${edlSummary.speed_floor_ratio}`);
  for (const item of edlSummary.repeated_windows_top3) {
    console.log(`[final-structure-gap] repeated window ${item.source_start}-${item.source_end}s count=${item.count} timeline_total=${item.timeline_total_sec}s segments=${item.segment_ids.join(',')}`);
  }
  for (const finding of findings) {
    console.log(`[final-structure-gap] finding: ${finding}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert(args.generated, '--generated는 필수입니다.');
  assert(args.edl, '--edl은 필수입니다.');

  const generatedPath = path.resolve(args.generated);
  const edlPath = path.resolve(args.edl);
  const referencePath = resolveReferencePath(args);

  assert(referencePath, '--reference 또는 --sample이 필요합니다.');
  assert(fs.existsSync(generatedPath), `generated 파일이 없습니다: ${generatedPath}`);
  assert(fs.existsSync(edlPath), `edl 파일이 없습니다: ${edlPath}`);
  assert(fs.existsSync(referencePath), `reference 파일이 없습니다: ${referencePath}`);

  const comparison = await compareVideos(generatedPath, referencePath);
  const edl = loadJson(edlPath);
  const edlSummary = summarizeEdl(edl);
  const findings = buildFindings(comparison, edlSummary);
  const payload = {
    sample: args.sample || null,
    generated: comparison.generated,
    reference: comparison.reference,
    scores: comparison.scores,
    deltas: comparison.deltas,
    duration_ratio: round(safeNumber(comparison.generated.durationSec) / Math.max(safeNumber(comparison.reference.durationSec), 1), 4),
    edl: edlSummary,
    findings,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printReport(args.sample, comparison, edlSummary, findings);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[final-structure-gap] 실패:', error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveReferencePath,
  summarizeEdl,
  buildFindings,
  main,
};
