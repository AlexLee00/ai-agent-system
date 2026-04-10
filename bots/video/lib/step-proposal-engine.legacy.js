'use strict';

const fs = require('fs');
const path = require('path');

const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { listKeywordMatches, matchByEmbedding } = require('./sync-matcher');

function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStepConfig(config) {
  return {
    auto_confirm_threshold: Number(config?.step_proposal?.auto_confirm_threshold || 0.8),
    red_required_below: Number(config?.step_proposal?.red_required_below || 0.5),
    blue_required_below_red: Number(config?.step_proposal?.blue_required_below_red || 50),
    red_model: String(config?.step_proposal?.red_model || 'gpt-4o-mini'),
    blue_max_alternatives: Number(config?.step_proposal?.blue_max_alternatives || 3),
    step_types: config?.step_proposal?.step_types || ['sync_match', 'cut', 'transition', 'video_insert', 'audio_sync', 'intro', 'outro'],
  };
}

function resolveStepConfig(config) {
  return ensureStepConfig(config);
}

function normalizeConfidence(match = {}) {
  const labelMap = { high: 0.85, medium: 0.6, low: 0.3 };
  if (typeof match.match_score === 'number') {
    return clamp01(match.match_score, 0.5);
  }
  if (typeof match.match_score === 'string' && labelMap[match.match_score]) {
    return labelMap[match.match_score];
  }

  if (typeof match.confidence === 'string' && labelMap[match.confidence]) {
    return labelMap[match.confidence];
  }
  return labelMap[match.match_type === 'hold' ? 'low' : 'medium'] || 0.5;
}

function safeJsonParseObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [
    raw.match(/```json\s*([\s\S]*?)```/i)?.[1],
    raw.match(/```\s*([\s\S]*?)```/i)?.[1],
    raw.match(/\{[\s\S]*\}/)?.[0],
    raw,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
      // 다음 후보 시도
    }
  }
  return null;
}

function confidenceLabel(value) {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}

function buildReason(match = {}) {
  const matchType = String(match.match_type || 'sync_match');
  if (matchType === 'keyword') {
    const overlap = ensureArray(match.overlap_keywords).join(', ');
    return overlap ? `키워드 매칭: ${overlap}` : '키워드 매칭';
  }
  if (matchType === 'embedding') {
    return `임베딩 유사도 매칭 (score: ${Number(match.match_score || 0).toFixed(2)})`;
  }
  if (matchType === 'hold') {
    return `이전 장면 유지 (원본 세그먼트: ${match.hold_from_segment_id || '없음'})`;
  }
  if (matchType === 'unmatched') {
    return '매칭 실패 — RED 검토 필요';
  }
  return '기본 싱크 매칭';
}

function deriveStepType(match = {}, confidence = null) {
  const safeConfidence = confidence == null ? normalizeConfidence(match) : Number(confidence || 0);
  const speedFactor = Number(match.speed_factor || 1);
  const sceneType = String(match?.source?.scene_type || '');
  const narration = match?.narration || {};
  const narrationDuration = Math.max(0, Number(narration.end_s || 0) - Number(narration.start_s || 0));

  if (match.match_type === 'unmatched' || !match.source) {
    return 'video_insert';
  }
  if (match.match_type === 'hold' || safeConfidence < 0.4) {
    return 'cut';
  }
  if (Math.abs(speedFactor - 1) >= 0.2) {
    return 'audio_sync';
  }
  if (sceneType.includes('transition') || sceneType.includes('outro') || sceneType.includes('intro') || narrationDuration <= 4) {
    return 'transition';
  }
  if (!String(match?.source?.description || '').trim()) {
    return 'video_insert';
  }
  return 'sync_match';
}

function buildSyncProposal(match = {}) {
  const normalizedConfidence = normalizeConfidence(match);
  const rawMatchScore = match.match_score;
  const stepType = deriveStepType(match, normalizedConfidence);
  return {
    step_type_hint: stepType,
    segment_id: match.segment_id,
    narration: match.narration || null,
    source: match.source || null,
    match_type: match.match_type || 'sync_match',
    match_score: typeof rawMatchScore === 'number'
      ? clamp01(rawMatchScore, normalizedConfidence)
      : normalizedConfidence,
    match_score_raw: rawMatchScore ?? null,
    overlap_keywords: ensureArray(match.overlap_keywords),
    speed_factor: Number(match.speed_factor || 1),
    hold_from_segment_id: match.hold_from_segment_id || null,
    reason: buildReason(match),
  };
}

function buildBoundaryStep(stepType, clip, reason) {
  const durationSec = Number(clip?.durationSec || clip?.duration_sec || 0);
  return {
    step_type: stepType,
    proposal: {
      clip_path: clip?.clipPath || clip?.clip_path || null,
      duration_sec: durationSec,
      reason,
    },
    confidence: 1,
    auto_confirm: true,
    red: null,
    blue: null,
    user_action: null,
    final: null,
  };
}

function generateSteps(syncMap, config = {}, options = {}) {
  const stepConfig = ensureStepConfig(config);
  const matches = ensureArray(syncMap?.matches);
  const steps = [];

  if (options.introClip && stepConfig.step_types.includes('intro')) {
    steps.push(buildBoundaryStep('intro', options.introClip, '인트로 클립 삽입'));
  }

  for (const match of matches) {
    const confidence = normalizeConfidence(match);
    const stepType = deriveStepType(match, confidence);
    steps.push({
      step_type: stepType,
      proposal: buildSyncProposal(match),
      confidence,
      auto_confirm: confidence >= stepConfig.auto_confirm_threshold,
      red: null,
      blue: null,
      user_action: null,
      final: null,
    });
  }

  if (options.outroClip && stepConfig.step_types.includes('outro')) {
    steps.push(buildBoundaryStep('outro', options.outroClip, '아웃트로 클립 삽입'));
  }

  return steps.map((step, index) => ({
    step_index: index,
    ...step,
  }));
}

async function attachRedEvaluation(steps, config = {}) {
  const stepConfig = ensureStepConfig(config);

  const nextSteps = [];
  for (const step of ensureArray(steps)) {
    if (['intro', 'outro'].includes(step.step_type) || Number(step.confidence || 0) >= stepConfig.red_required_below) {
      nextSteps.push({ ...step, red: null });
      continue;
    }

    const narration = step.proposal?.narration || {};
    const source = step.proposal?.source || {};
    const systemPrompt = [
      '당신은 비디오 편집 RED 리뷰어다.',
      '주어진 나레이션과 원본 장면 매칭의 적절성을 0~100 점수와 한 줄 코멘트로 평가하라.',
      '반드시 JSON 객체만 반환하라.',
      '{"score": 0, "comment": "..." }',
    ].join('\n');
    const userPrompt = [
      `segment_id=${step.proposal?.segment_id || 'unknown'}`,
      `topic=${narration.topic || ''}`,
      `narration_range=${narration.start_s || 0}~${narration.end_s || 0}`,
      `source_description=${source.description || ''}`,
      `source_scene_type=${source.scene_type || ''}`,
      `match_type=${step.proposal?.match_type || ''}`,
      `match_score=${Number(step.proposal?.match_score || 0).toFixed(4)}`,
      `reason=${step.proposal?.reason || ''}`,
      '이 매칭이 편집 스텝으로 적절한지 평가하라.',
    ].join('\n');

    try {
      const result = await callWithFallback({
        chain: selectLLMChain('video.step-proposal'),
        systemPrompt,
        userPrompt,
        logMeta: {
          team: 'video',
          purpose: 'editing',
          bot: 'step-proposal-engine',
          agentName: 'edi',
          selectorKey: 'video.step-proposal',
          requestType: 'step_red_evaluation',
        },
      });
      const parsed = safeJsonParseObject(result.text);
      nextSteps.push({
        ...step,
        red: {
          score: Math.max(0, Math.min(100, Number(parsed?.score ?? -1))),
          comment: String(parsed?.comment || '평가 코멘트 없음').trim(),
          provider: result.provider,
          model: result.model,
        },
      });
    } catch (error) {
      nextSteps.push({
        ...step,
        red: {
          score: -1,
          comment: `평가 스킵: ${error.message || String(error)}`,
        },
      });
    }
  }

  return nextSteps;
}

function buildSceneSearchSegment(step) {
  const narration = step?.proposal?.narration || {};
  const keywords = ensureArray(step?.proposal?.overlap_keywords);
  const topicWords = String(narration.topic || '')
    .split(/[\s,./()_-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  return {
    segment_id: step?.proposal?.segment_id || `step_${step?.step_index || 0}`,
    start_s: narration.start_s || 0,
    end_s: narration.end_s || 0,
    topic: narration.topic || '',
    required_screen: step?.proposal?.reason || '',
    keywords_en: [...new Set([...keywords, ...topicWords])],
    keywords_ko: [...new Set([...keywords, ...topicWords])],
    action_verbs: [],
  };
}

function normalizeAlternativeSource(scene) {
  if (!scene) return null;
  return {
    frame_id: scene.frame_id,
    start_s: scene.timestamp_s ?? scene.start_s ?? 0,
    end_s: scene.timestamp_end_s ?? scene.end_s ?? 0,
    description: scene.description || '',
    scene_type: scene.scene_type || '',
  };
}

async function attachBlueAlternative(steps, sceneIndex, config = {}) {
  const stepConfig = ensureStepConfig(config);
  const scenes = ensureArray(sceneIndex?.scenes);
  const nextSteps = [];

  for (const step of ensureArray(steps)) {
    const redScore = Number(step?.red?.score ?? 100);
    if (['intro', 'outro'].includes(step.step_type) || redScore < 0 || redScore >= stepConfig.blue_required_below_red) {
      nextSteps.push({ ...step, blue: null });
      continue;
    }

    const currentFrameId = step?.proposal?.source?.frame_id || null;
    const candidateScenes = scenes.filter((scene) => String(scene.frame_id || '') !== String(currentFrameId || ''));
    const segment = buildSceneSearchSegment(step);

    let candidate = null;
    const keywordCandidates = listKeywordMatches(segment, candidateScenes, config);
    if (keywordCandidates.length > 0) {
      candidate = keywordCandidates[0];
    } else {
      try {
        candidate = await matchByEmbedding(segment, candidateScenes, config, new Map());
      } catch (_error) {
        candidate = null;
      }
    }

    if (!candidate?.source) {
      nextSteps.push({ ...step, blue: null });
      continue;
    }

    nextSteps.push({
      ...step,
      blue: {
        alternative_source: normalizeAlternativeSource(candidate.source),
        alternatives: [
          {
            source: normalizeAlternativeSource(candidate.source),
            match_type: candidate.match_type,
            match_score: Number(candidate.match_score || 0),
          },
        ].slice(0, Math.max(1, stepConfig.blue_max_alternatives)),
        score: Math.max(0, Math.min(100, Math.round(Number(candidate.match_score || 0) * 100))),
        match_type: candidate.match_type,
        match_score: Number(candidate.match_score || 0),
        reason: candidate.match_type === 'keyword'
          ? `대안 장면 제안: 키워드 재매칭 (${ensureArray(candidate.overlap_keywords).join(', ') || '키워드 재해석'})`
          : `대안 장면 제안: 임베딩 재매칭 (score: ${Number(candidate.match_score || 0).toFixed(2)})`,
      },
    });
  }

  return nextSteps;
}

function applyUserAction(steps, stepIndex, action, modification = null) {
  const nextSteps = ensureArray(steps).map((step) => ({ ...step }));
  const target = nextSteps.find((step) => Number(step.step_index) === Number(stepIndex));
  if (!target) {
    throw new Error(`step_index=${stepIndex} 스텝을 찾지 못했습니다.`);
  }

  target.user_action = action;
  if (action === 'confirm') {
    target.final = { ...target.proposal };
  } else if (action === 'modify') {
    target.final = { ...target.proposal, ...(modification || {}) };
  } else if (action === 'skip') {
    target.final = null;
  } else if (action === 'adopt_blue') {
    target.final = target.blue?.alternative_source
      ? {
          ...target.proposal,
          source: target.blue.alternative_source,
          match_type: target.blue.match_type || target.proposal.match_type,
          match_score: Number(target.blue.match_score || target.proposal.match_score || 0),
          reason: target.blue.reason || target.proposal.reason,
        }
      : null;
  } else {
    throw new Error(`지원하지 않는 action: ${action}`);
  }

  steps.splice(0, steps.length, ...nextSteps);
  return target;
}

function stepsToSyncMap(steps) {
  const syncSteps = ensureArray(steps).filter((step) => !['intro', 'outro'].includes(step.step_type) && step.final);
  const matches = syncSteps.map((step) => ({
    segment_id: step.final.segment_id,
    narration: step.final.narration || null,
    source: step.final.source || null,
    match_type: step.final.match_type || 'sync_match',
    match_score: Number(step.final.match_score || step.confidence || 0),
    overlap_keywords: ensureArray(step.final.overlap_keywords),
    speed_factor: Number(step.final.speed_factor || 1),
    confidence: confidenceLabel(Number(step.confidence || step.final.match_score || 0)),
    hold_from_segment_id: step.final.hold_from_segment_id || null,
    narration_start_s: step.final.narration?.start_s ?? null,
    narration_end_s: step.final.narration?.end_s ?? null,
  }));

  const matchedKeyword = matches.filter((match) => match.match_type === 'keyword').length;
  const matchedEmbedding = matches.filter((match) => match.match_type === 'embedding').length;
  const matchedHold = matches.filter((match) => match.match_type === 'hold').length;
  const unmatched = matches.filter((match) => match.match_type === 'unmatched').length;
  const overallConfidence = matches.length
    ? Number((matches.reduce((sum, match) => sum + Number(match.match_score || 0), 0) / matches.length).toFixed(4))
    : 0;

  return {
    total_segments: matches.length,
    matched_keyword: matchedKeyword,
    matched_embedding: matchedEmbedding,
    matched_hold: matchedHold,
    unmatched,
    overall_confidence: overallConfidence,
    matches,
  };
}

function saveSteps(steps, outputDir) {
  const targetDir = path.resolve(outputDir || process.cwd());
  fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, 'steps.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(steps, null, 2)}\n`, 'utf8');
  return outputPath;
}

function loadSteps(stepsPath) {
  return JSON.parse(fs.readFileSync(path.resolve(stepsPath), 'utf8'));
}

module.exports = {
  resolveStepConfig,
  normalizeConfidence,
  generateSteps,
  attachRedEvaluation,
  attachBlueAlternative,
  applyUserAction,
  stepsToSyncMap,
  saveSteps,
  loadSteps,
};
