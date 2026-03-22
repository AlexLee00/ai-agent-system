'use strict';

const fs = require('fs');
const path = require('path');

const { createEmbedding } = require('../../../packages/core/lib/rag');

function safeParseFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureSyncMatcherConfig(config = {}) {
  return {
    keyword_min_overlap: Number(config?.sync_matcher?.keyword_min_overlap || 2),
    embedding_threshold: Number(config?.sync_matcher?.embedding_threshold || 0.5),
    time_reorder_penalty: Number(config?.sync_matcher?.time_reorder_penalty || 0.3),
    max_speed_factor: Number(config?.sync_matcher?.max_speed_factor || 2),
    min_speed_factor: Number(config?.sync_matcher?.min_speed_factor || 0.5),
    unmatched_strategy: String(config?.sync_matcher?.unmatched_strategy || 'hold'),
    short_source_window_sec: Number(config?.sync_matcher?.short_source_window_sec || 30),
    repeated_window_penalty: Number(config?.sync_matcher?.repeated_window_penalty || 0.2),
  };
}

function normalizeKeywords(words = []) {
  return [...new Set((Array.isArray(words) ? words : [])
    .map((word) => String(word || '').trim().toLowerCase())
    .filter((word) => word.length >= 3))];
}

function overlapKeywords(a, b) {
  const setB = new Set(normalizeKeywords(b));
  return normalizeKeywords(a).filter((word) => setB.has(word));
}

function segmentDuration(segment) {
  return Math.max(0.1, safeParseFloat(segment.end_s) - safeParseFloat(segment.start_s));
}

function sceneDuration(scene) {
  return Math.max(0.1, safeParseFloat(scene.timestamp_end_s) - safeParseFloat(scene.timestamp_s));
}

function matchByKeywords(segment, scenes, config = {}) {
  const candidates = listKeywordMatches(segment, scenes, config);
  return candidates[0] || null;
}

function listKeywordMatches(segment, scenes, config = {}) {
  const resolved = ensureSyncMatcherConfig(config);
  const candidates = [];
  for (const scene of scenes) {
    const overlap = overlapKeywords(segment.keywords_en, scene.keywords_en);
    const score = overlap.length / Math.max(normalizeKeywords(segment.keywords_en).length, 1);
    if (overlap.length >= resolved.keyword_min_overlap) {
      candidates.push({
        segment_id: segment.segment_id,
        source: scene,
        match_type: 'keyword',
        match_score: Number(score.toFixed(4)),
        overlap_keywords: overlap,
        confidence: overlap.length >= 4 ? 'high' : 'medium',
      });
    }
  }

  candidates.sort((a, b) => b.match_score - a.match_score || a.source.timestamp_s - b.source.timestamp_s);
  return candidates;
}

function sceneKey(scene) {
  if (!scene) return 'none';
  return `${scene.frame_id || 'na'}:${safeParseFloat(scene.timestamp_s, 0)}:${safeParseFloat(scene.timestamp_end_s, 0)}`;
}

function penalizeRepeatedWindow(match, usageByScene, config = {}) {
  const resolved = ensureSyncMatcherConfig(config);
  if (!match?.source) return match;
  const sourceStart = safeParseFloat(match.source.timestamp_s, 0);
  const sourceEnd = safeParseFloat(match.source.timestamp_end_s, 0);
  const sourceDuration = Math.max(0, sourceEnd - sourceStart);
  if (sourceDuration > resolved.short_source_window_sec) return match;

  const key = sceneKey(match.source);
  const usage = Number(usageByScene.get(key) || 0);
  if (usage <= 0) return match;

  const penalty = resolved.repeated_window_penalty * usage;
  const nextScore = Number(Math.max(0, match.match_score - penalty).toFixed(4));
  return {
    ...match,
    match_score: nextScore,
    repeated_window_penalized: true,
    repeated_window_usage: usage,
    confidence: nextScore >= 0.7 ? 'high' : (nextScore >= 0.5 ? 'medium' : 'low'),
  };
}

async function matchByEmbedding(segment, scenes, config = {}, cache = new Map()) {
  const resolved = ensureSyncMatcherConfig(config);
  const segmentText = [
    segment.topic,
    segment.required_screen,
    ...(segment.keywords_en || []),
    ...(segment.keywords_ko || []),
    ...(segment.action_verbs || []),
  ].join(' ').trim();

  if (!segmentText) return null;
  const segmentEmbedding = await createEmbedding(segmentText);
  let best = null;

  for (const scene of scenes) {
    const cacheKey = `${scene.frame_id}`;
    let sceneEmbedding = cache.get(cacheKey);
    if (!sceneEmbedding) {
      const sceneText = [
        scene.description,
        ...(scene.keywords_en || []),
        ...(scene.keywords_ko || []),
      ].join(' ').trim();
      if (!sceneText) continue;
      sceneEmbedding = await createEmbedding(sceneText);
      cache.set(cacheKey, sceneEmbedding);
    }

    const similarity = cosineSimilarity(segmentEmbedding, sceneEmbedding);
    if (similarity < resolved.embedding_threshold) continue;

    const candidate = {
      segment_id: segment.segment_id,
      source: scene,
      match_type: 'embedding',
      match_score: Number(similarity.toFixed(4)),
      overlap_keywords: overlapKeywords(segment.keywords_en, scene.keywords_en),
      confidence: similarity >= 0.7 ? 'high' : 'medium',
    };
    if (!best || candidate.match_score > best.match_score) {
      best = candidate;
    }
  }

  return best;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function applyTimeOrdering(matches, config = {}) {
  const resolved = ensureSyncMatcherConfig(config);
  let lastStart = -1;
  return matches.map((match) => {
    if (!match || !match.source) return match;
    const start = safeParseFloat(match.source.timestamp_s, 0);
    const next = { ...match };
    if (start < lastStart) {
      next.match_score = Number(Math.max(0, next.match_score - resolved.time_reorder_penalty).toFixed(4));
      next.time_order_penalized = true;
      next.confidence = next.match_score >= 0.7 ? 'high' : (next.match_score >= 0.5 ? 'medium' : 'low');
    } else {
      lastStart = start;
    }
    return next;
  });
}

function handleUnmatched(segments, matches, scenes = [], config = {}) {
  const resolved = ensureSyncMatcherConfig(config);
  const bySegment = new Map(matches.filter(Boolean).map((match) => [match.segment_id, match]));
  const filled = [];
  let previous = null;

  for (const segment of segments) {
    const matched = bySegment.get(segment.segment_id);
    if (matched) {
      filled.push(matched);
      previous = matched;
      continue;
    }

    if (resolved.unmatched_strategy === 'hold' && previous) {
      filled.push({
        segment_id: segment.segment_id,
        source: previous.source,
        match_type: 'hold',
        match_score: Number(Math.max(0.2, previous.match_score * 0.8).toFixed(4)),
        overlap_keywords: previous.overlap_keywords || [],
        confidence: 'low',
        hold_from_segment_id: previous.segment_id,
      });
      continue;
    }

    if (resolved.unmatched_strategy === 'hold') {
      const nextMatched = segments
        .slice(segments.findIndex((item) => item.segment_id === segment.segment_id) + 1)
        .map((item) => bySegment.get(item.segment_id))
        .find(Boolean);
      const anchorSource = nextMatched?.source || scenes[0] || null;
      if (anchorSource) {
        filled.push({
          segment_id: segment.segment_id,
          source: anchorSource,
          match_type: 'hold',
          match_score: Number(Math.max(0.15, Number(nextMatched?.match_score || 0.25) * 0.6).toFixed(4)),
          overlap_keywords: [],
          confidence: 'low',
          hold_from_segment_id: nextMatched?.segment_id || null,
        });
        continue;
      }
    }

    filled.push({
      segment_id: segment.segment_id,
      source: null,
      match_type: 'unmatched',
      match_score: 0,
      overlap_keywords: [],
      confidence: 'low',
    });
  }

  return filled;
}

function calculateSpeedFactor(segment, scene, config = {}) {
  const resolved = ensureSyncMatcherConfig(config);
  if (!scene) return 1;
  const factor = sceneDuration(scene) / segmentDuration(segment);
  return Number(Math.min(resolved.max_speed_factor, Math.max(resolved.min_speed_factor, factor)).toFixed(4));
}

async function buildSyncMap(sceneIndex, narrationAnalysis, config = {}, options = {}) {
  const scenes = Array.isArray(sceneIndex?.scenes) ? sceneIndex.scenes : [];
  const segments = Array.isArray(narrationAnalysis?.segments) ? narrationAnalysis.segments : [];
  const embeddingCache = new Map();
  const usageByScene = new Map();

  let matchedKeyword = 0;
  let matchedEmbedding = 0;
  let matchedHold = 0;
  let unmatched = 0;

  const initialMatches = [];
  for (const segment of segments) {
    const keywordCandidates = listKeywordMatches(segment, scenes, config)
      .map((candidate) => penalizeRepeatedWindow(candidate, usageByScene, config))
      .sort((a, b) => b.match_score - a.match_score || a.source.timestamp_s - b.source.timestamp_s);
    let match = keywordCandidates[0] || null;
    if (match) {
      matchedKeyword += 1;
      initialMatches.push(match);
      usageByScene.set(sceneKey(match.source), Number(usageByScene.get(sceneKey(match.source)) || 0) + 1);
      continue;
    }
    try {
      match = await matchByEmbedding(segment, scenes, config, embeddingCache);
    } catch (_error) {
      match = null;
    }
    if (match) {
      matchedEmbedding += 1;
      initialMatches.push(match);
      usageByScene.set(sceneKey(match.source), Number(usageByScene.get(sceneKey(match.source)) || 0) + 1);
    }
  }

  const ordered = applyTimeOrdering(
    segments.map((segment) => initialMatches.find((item) => item.segment_id === segment.segment_id) || null).filter(Boolean),
    config
  );
  const orderedById = new Map(ordered.map((item) => [item.segment_id, item]));
  const filled = handleUnmatched(
    segments,
    segments.map((segment) => orderedById.get(segment.segment_id)).filter(Boolean),
    scenes,
    config
  );

  const matches = filled.map((match) => {
    const segment = segments.find((item) => item.segment_id === match.segment_id);
    if (match.match_type === 'hold') matchedHold += 1;
    if (match.match_type === 'unmatched') unmatched += 1;
    const source = match.source;
    return {
      segment_id: segment.segment_id,
      narration: {
        start_s: segment.start_s,
        end_s: segment.end_s,
        topic: segment.topic,
      },
      source: source ? {
        frame_id: source.frame_id,
        start_s: source.timestamp_s,
        end_s: source.timestamp_end_s,
        description: source.description,
        scene_type: source.scene_type,
      } : null,
      match_type: match.match_type,
      match_score: match.match_score,
      overlap_keywords: match.overlap_keywords,
      speed_factor: source ? calculateSpeedFactor(segment, source, config) : 1,
      confidence: match.confidence,
      hold_from_segment_id: match.hold_from_segment_id || null,
      narration_start_s: segment.start_s,
      narration_end_s: segment.end_s,
    };
  });

  const matchedCount = matches.filter((item) => item.match_type !== 'unmatched').length;
  const overallConfidence = matchedCount
    ? Number((matches.reduce((sum, item) => sum + Number(item.match_score || 0), 0) / matches.length).toFixed(4))
    : 0;

  const syncMap = {
    total_segments: segments.length,
    matched_keyword: matchedKeyword,
    matched_embedding: matchedEmbedding,
    matched_hold: matchedHold,
    unmatched,
    overall_confidence: overallConfidence,
    matches,
  };

  const baseDir = options.tempDir
    || (sceneIndex?.output_path ? path.dirname(sceneIndex.output_path) : process.cwd());
  const outputPath = path.join(baseDir, 'sync_map.json');
  fs.writeFileSync(outputPath, JSON.stringify(syncMap, null, 2), 'utf8');
  return { ...syncMap, output_path: outputPath };
}

function buildClip(sourceId, clipType, sourceStart, sourceEnd, timelineStart, timelineEnd, speed, extra = {}) {
  return {
    source_id: sourceId,
    clip_type: clipType,
    source_start: Number(sourceStart.toFixed(3)),
    source_end: Number(sourceEnd.toFixed(3)),
    timeline_start: Number(timelineStart.toFixed(3)),
    timeline_end: Number(timelineEnd.toFixed(3)),
    speed: Number(speed.toFixed(4)),
    ...extra,
  };
}

function syncMapToEDL(syncMap, sourceVideoPath, narrationAudioPath, introClip = null, outroClip = null) {
  const inputs = [
    { id: 'main', type: 'video', path: path.resolve(sourceVideoPath) },
    { id: 'narration', type: 'audio', path: path.resolve(narrationAudioPath) },
  ];
  const clips = [];
  let timelineCursor = 0;

  if (introClip?.clipPath && Number(introClip.durationSec || 0) > 0) {
    inputs.push({ id: 'intro', type: 'video', path: path.resolve(introClip.clipPath) });
    clips.push(buildClip('intro', 'intro', 0, introClip.durationSec, timelineCursor, timelineCursor + introClip.durationSec, 1));
    timelineCursor += introClip.durationSec;
  }

  for (const match of syncMap.matches || []) {
    const source = match.source;
    const narrationStart = safeParseFloat(match.narration_start_s, match.narration?.start_s || 0);
    const narrationEnd = safeParseFloat(match.narration_end_s, match.narration?.end_s || narrationStart);
    const duration = narrationEnd - narrationStart;
    if (!source || duration <= 0) continue;
    clips.push(buildClip(
      'main',
      'main',
      safeParseFloat(source.start_s),
      safeParseFloat(source.end_s),
      timelineCursor,
      timelineCursor + duration,
      Number(match.speed_factor || 1),
      {
        segment_id: match.segment_id,
        narration_start: narrationStart,
        narration_end: narrationEnd,
        match_type: match.match_type,
        match_score: match.match_score,
      }
    ));
    timelineCursor += duration;
  }

  if (outroClip?.clipPath && Number(outroClip.durationSec || 0) > 0) {
    inputs.push({ id: 'outro', type: 'video', path: path.resolve(outroClip.clipPath) });
    clips.push(buildClip('outro', 'outro', 0, outroClip.durationSec, timelineCursor, timelineCursor + outroClip.durationSec, 1));
    timelineCursor += outroClip.durationSec;
  }

  return {
    version: 2,
    source: path.resolve(sourceVideoPath),
    audio: path.resolve(narrationAudioPath),
    duration: Number(timelineCursor.toFixed(3)),
    inputs,
    clips,
    subtitle_offset_sec: Number(introClip?.durationSec || 0),
    edits: [],
  };
}

module.exports = {
  matchByKeywords,
  listKeywordMatches,
  matchByEmbedding,
  applyTimeOrdering,
  handleUnmatched,
  calculateSpeedFactor,
  buildSyncMap,
  syncMapToEDL,
};
