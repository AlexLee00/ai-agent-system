// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const pgPool = require('../../../packages/core/lib/pg-pool');
const rag = require('../../../packages/core/lib/rag-safe');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const BOT_NAME = 'video';
const COLLECTION = 'rag_video';

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function buildEditResultContent(editResult) {
  return [
    editResult.title || '무제',
    `길이:${safeNumber(editResult.duration || editResult.duration_s, 0)}s`,
    `자막:${safeNumber(editResult.subtitleCount || editResult.subtitle_count, 0)}개`,
    `점수:${safeNumber(editResult.qualityScore || editResult.quality_score, 0)}`,
    `컷:${safeNumber(editResult.cutCount || editResult.cut_count, 0)}개`,
    `전환:${safeNumber(editResult.transitionCount || editResult.transition_count, 0)}개`,
    `무음:${safeNumber(editResult.silenceCount || editResult.silence_count, 0)}개`,
    `정지:${safeNumber(editResult.freezeCount || editResult.freeze_count, 0)}개`,
    `자막이슈:${safeNumber(editResult.subtitleIssuesCount || editResult.subtitle_issues_count, 0)}건`,
    `오디오이슈:${safeNumber(editResult.audioIssuesCount || editResult.audio_issues_count, 0)}건`,
  ].join(' | ');
}

function buildEditResultMetadata(editResult) {
  const createdAt = editResult.created_at || new Date().toISOString();
  const editTypes = uniqueStrings(editResult.edlEditTypes || editResult.edl_edit_types);
  return {
    type: 'edit_result',
    edit_id: editResult.editId ?? editResult.edit_id ?? null,
    session_id: editResult.sessionId ?? editResult.session_id ?? null,
    pair_index: editResult.pairIndex ?? editResult.pair_index ?? null,
    title: editResult.title || '무제',
    duration_s: safeNumber(editResult.duration || editResult.duration_s, 0),
    subtitle_count: safeNumber(editResult.subtitleCount || editResult.subtitle_count, 0),
    quality_score: safeNumber(editResult.qualityScore || editResult.quality_score, 0),
    quality_pass: Boolean(editResult.qualityPass ?? editResult.quality_pass),
    cut_count: safeNumber(editResult.cutCount || editResult.cut_count, 0),
    transition_count: safeNumber(editResult.transitionCount || editResult.transition_count, 0),
    silence_count: safeNumber(editResult.silenceCount || editResult.silence_count, 0),
    freeze_count: safeNumber(editResult.freezeCount || editResult.freeze_count, 0),
    subtitle_issues_count: safeNumber(editResult.subtitleIssuesCount || editResult.subtitle_issues_count, 0),
    audio_issues_count: safeNumber(editResult.audioIssuesCount || editResult.audio_issues_count, 0),
    subtitle_issue_types: uniqueStrings(editResult.subtitleIssueTypes || editResult.subtitle_issue_types),
    audio_issue_types: uniqueStrings(editResult.audioIssueTypes || editResult.audio_issue_types),
    video_issue_types: uniqueStrings(editResult.videoIssueTypes || editResult.video_issue_types),
    edl_edit_types: editTypes,
    total_ms: safeNumber(editResult.totalMs || editResult.total_ms, 0),
    total_cost_usd: safeNumber(editResult.totalCostUsd || editResult.total_cost_usd, 0),
    video_width: safeNumber(editResult.videoWidth || editResult.video_width, 0),
    video_height: safeNumber(editResult.videoHeight || editResult.video_height, 0),
    video_fps: safeNumber(editResult.videoFps || editResult.video_fps, 0),
    created_at: createdAt,
  };
}

function inferFeedbackTags(feedback = {}) {
  const text = `${feedback.text || ''} ${feedback.rejectReason || ''}`.toLowerCase();
  const tags = [];
  if (text.includes('자막')) tags.push('자막수정');
  if (text.includes('컷') || text.includes('잘라')) tags.push('컷추가');
  if (text.includes('전환') || text.includes('페이드')) tags.push('전환조정');
  if (text.includes('오디오') || text.includes('볼륨')) tags.push('오디오조정');
  if (!tags.length && feedback.confirmed) tags.push('승인');
  if (!tags.length && !feedback.confirmed) tags.push('재검토');
  return uniqueStrings(tags);
}

async function safeStore(content, metadata) {
  const startedAt = Date.now();
  try {
    const ragId = await rag.store(COLLECTION, content, metadata, BOT_NAME);
    await logToolCall('video_rag', 'store', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        type: metadata.type,
        stored: Boolean(ragId),
      },
    });
    return ragId;
  } catch (error) {
    await logToolCall('video_rag', 'store', {
      bot: BOT_NAME,
      success: false,
      duration_ms: Date.now() - startedAt,
      error: toErrorMessage(error),
      metadata: { type: metadata.type },
    });
    return null;
  }
}

async function safeSearch(query, opts = {}) {
  const startedAt = Date.now();
  try {
    const results = await rag.search(COLLECTION, query, opts, { sourceBot: BOT_NAME });
    await logToolCall('video_rag', 'search', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        limit: opts.limit || 5,
        threshold: opts.threshold ?? null,
        resultCount: Array.isArray(results) ? results.length : 0,
      },
    });
    return Array.isArray(results) ? results : [];
  } catch (error) {
    await logToolCall('video_rag', 'search', {
      bot: BOT_NAME,
      success: false,
      duration_ms: Date.now() - startedAt,
      error: toErrorMessage(error),
      metadata: {
        limit: opts.limit || 5,
        threshold: opts.threshold ?? null,
      },
    });
    return [];
  }
}

async function storeEditResult(editResult, _config) {
  try {
    const content = buildEditResultContent(editResult || {});
    const metadata = buildEditResultMetadata(editResult || {});
    const ragId = await safeStore(content, metadata);
    if (!ragId) {
      return { ragId: null, stored: false, reason: 'rag_store_unavailable' };
    }
    return { ragId, stored: true };
  } catch (error) {
    return { ragId: null, stored: false, reason: toErrorMessage(error) };
  }
}

async function storeEditFeedback(editId, feedback, _config) {
  try {
    const rows = await pgPool.query(
      'public',
      `SELECT ve.id, ve.title, vs.title AS session_title
         FROM video_edits ve
         LEFT JOIN video_sessions vs ON vs.id = ve.session_id
        WHERE ve.id = $1`,
      [editId]
    );
    const row = rows[0] || {};
    const title = row.session_title || row.title || `edit_${editId}`;
    const content = [
      title,
      `피드백:${String(feedback?.text || '').trim() || '(없음)'}`,
      `확인:${Boolean(feedback?.confirmed)}`,
      `수정사유:${String(feedback?.rejectReason || '').trim() || '(없음)'}`,
    ].join(' | ');
    const metadata = {
      type: 'edit_feedback',
      edit_id: editId,
      title,
      confirmed: Boolean(feedback?.confirmed),
      reject_reason: String(feedback?.rejectReason || '').trim() || null,
      feedback_text: String(feedback?.text || '').trim() || '',
      feedback_tags: inferFeedbackTags(feedback),
      created_at: new Date().toISOString(),
    };
    const ragId = await safeStore(content, metadata);
    if (!ragId) {
      return { ragId: null, stored: false, reason: 'rag_store_unavailable' };
    }
    return { ragId, stored: true };
  } catch (error) {
    return { ragId: null, stored: false, reason: toErrorMessage(error) };
  }
}

async function searchSimilarEdits(query, options = {}) {
  const type = options.type || null;
  const minScore = safeNumber(options.minScore, 0);
  const results = await safeSearch(query, {
    limit: safeNumber(options.limit, 5),
    threshold: options.threshold ?? 0.3,
    filter: type ? { type } : null,
    sourceBot: BOT_NAME,
  });
  return results.filter((item) => safeNumber(item?.metadata?.quality_score, minScore) >= minScore);
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

async function searchEditPatterns(analysisData, _config) {
  try {
    const duration = safeNumber(analysisData?.duration, 0);
    const silenceCount = Array.isArray(analysisData?.silences) ? analysisData.silences.length : 0;
    const freezeCount = Array.isArray(analysisData?.freezes) ? analysisData.freezes.length : 0;
    const sceneCount = Array.isArray(analysisData?.scenes) ? analysisData.scenes.length : 0;
    const query = `길이:${Math.round(duration)}s 무음:${silenceCount}개 정지:${freezeCount}개 씬전환:${sceneCount}개`;
    const patterns = await searchSimilarEdits(query, {
      limit: 5,
      threshold: 0.25,
      type: 'edit_result',
      minScore: 0,
    });

    const successful = patterns.filter((item) => safeNumber(item?.metadata?.quality_score, 0) >= 85);
    const basis = successful.length ? successful : patterns;
    const durationMinutes = duration > 0 ? duration / 60 : 0;

    const recommendedCuts = basis.map((item) => ({
      rag_id: item.id,
      title: item.metadata?.title || item.content,
      cut_count: safeNumber(item.metadata?.cut_count, 0),
      cut_density: (() => {
        const sampleMinutes = Math.max(1, safeNumber(item.metadata?.duration_s, 0) / 60);
        return Number((safeNumber(item.metadata?.cut_count, 0) / sampleMinutes).toFixed(2));
      })(),
      quality_score: safeNumber(item.metadata?.quality_score, 0),
      similarity: safeNumber(item.similarity, 0),
    }));

    const recommendedTransitions = basis.map((item) => ({
      rag_id: item.id,
      title: item.metadata?.title || item.content,
      transition_count: safeNumber(item.metadata?.transition_count, 0),
      transition_density: (() => {
        const sampleMinutes = Math.max(1, safeNumber(item.metadata?.duration_s, 0) / 60);
        return Number((safeNumber(item.metadata?.transition_count, 0) / sampleMinutes).toFixed(2));
      })(),
      quality_score: safeNumber(item.metadata?.quality_score, 0),
      similarity: safeNumber(item.similarity, 0),
    }));

    return {
      patterns,
      suggestions: {
        recommended_cuts: recommendedCuts,
        recommended_transitions: recommendedTransitions,
        avg_quality_score: Number(average(basis.map((item) => safeNumber(item?.metadata?.quality_score, 0))).toFixed(2)),
        avg_processing_time_ms: Math.round(average(basis.map((item) => safeNumber(item?.metadata?.total_ms, 0)))),
        sample_count: basis.length,
      },
    };
  } catch (_error) {
    return {
      patterns: [],
      suggestions: {
        recommended_cuts: [],
        recommended_transitions: [],
        avg_quality_score: 0,
        avg_processing_time_ms: 0,
        sample_count: 0,
      },
    };
  }
}

async function enhanceCriticWithRAG(criticReport, config) {
  try {
    const summary = criticReport?.analysis_summary || {};
    const query = [
      criticReport?.source_video || '',
      `길이:${Math.round(safeNumber(summary.duration_seconds, 0))}s`,
      `자막:${safeNumber(summary.subtitle_entries, 0)}개`,
      `무음:${safeNumber(summary.silences_count, 0)}개`,
      `정지:${safeNumber(summary.freezes_count, 0)}개`,
      `씬전환:${safeNumber(summary.scenes_count, 0)}개`,
    ].filter(Boolean).join(' ');

    const patterns = await searchSimilarEdits(query, {
      limit: 5,
      threshold: 0.25,
      type: 'edit_result',
      minScore: 0,
    });

    if (!patterns.length) {
      return {
        ...criticReport,
        rag_insights: {
          similar_edits_found: 0,
          recurring_issues: [],
          recommended_actions: [],
          historical_avg_score: 0,
        },
      };
    }

    const feedbackHits = await searchSimilarEdits(query, {
      limit: 5,
      threshold: 0.2,
      type: 'edit_feedback',
      minScore: 0,
    });

    const recurringIssueMap = new Map();
    for (const pattern of patterns) {
      for (const issueType of uniqueStrings([
        ...(pattern.metadata?.subtitle_issue_types || []),
        ...(pattern.metadata?.audio_issue_types || []),
        ...(pattern.metadata?.video_issue_types || []),
      ])) {
        recurringIssueMap.set(issueType, (recurringIssueMap.get(issueType) || 0) + 1);
      }
    }
    for (const issue of criticReport?.issues || []) {
      const key = String(issue.type || '').trim();
      if (!key) continue;
      recurringIssueMap.set(key, (recurringIssueMap.get(key) || 0) + 1);
    }

    const recurringIssues = [...recurringIssueMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([issueType]) => issueType);

    const recommendedActions = [];
    const avgTransitionDensity = average(patterns.map((item) => {
      const durationMinutes = Math.max(1, safeNumber(item.metadata?.duration_s, 0) / 60);
      return safeNumber(item.metadata?.transition_count, 0) / durationMinutes;
    }));
    if (avgTransitionDensity >= 1) {
      recommendedActions.push('과거 유사 영상에서 씬 전환 효과 밀도가 높을수록 품질 점수가 개선되는 경향이 있었습니다.');
    }
    if (feedbackHits.some((item) => (item.metadata?.feedback_tags || []).includes('자막수정'))) {
      recommendedActions.push('과거 유사 세션에서 자막 수정 피드백이 반복돼 자막 전문용어와 길이 검토를 우선하는 것이 좋습니다.');
    }
    if (!recommendedActions.length && patterns.length) {
      recommendedActions.push('과거 유사 영상의 고득점 편집 패턴을 참고해 컷/전환 밀도를 보수적으로 조정하는 것이 좋습니다.');
    }

    return {
      ...criticReport,
      rag_insights: {
        similar_edits_found: patterns.length,
        recurring_issues: recurringIssues,
        recommended_actions: recommendedActions,
        historical_avg_score: Number(average(patterns.map((item) => safeNumber(item.metadata?.quality_score, 0))).toFixed(2)),
      },
    };
  } catch (_error) {
    return criticReport;
  }
}

function hasTransitionNear(edits, at, tolerance = 1.0) {
  return (Array.isArray(edits) ? edits : []).some((edit) => (
    edit?.type === 'transition' && Math.abs(safeNumber(edit.at, 0) - safeNumber(at, 0)) <= tolerance
  ));
}

async function enhanceEDLWithRAG(edl, analysisData, config) {
  try {
    const patternResult = await searchEditPatterns(analysisData, config);
    const suggestions = patternResult.suggestions || {};
    const baseEdits = Array.isArray(edl?.edits) ? [...edl.edits] : [];
    const durationMinutes = Math.max(1, safeNumber(analysisData?.duration, 0) / 60);
    const targetTransitionCount = Math.round(average(
      (suggestions.recommended_transitions || []).map((item) => safeNumber(item.transition_count, 0))
    ));
    const currentTransitionCount = baseEdits.filter((edit) => edit?.type === 'transition').length;
    const transitionsToAdd = Math.max(0, Math.min(3, targetTransitionCount - currentTransitionCount));
    const rankedScenes = [...(analysisData?.scenes || [])]
      .map((scene) => ({ at: safeNumber(scene.at, 0), score: safeNumber(scene.score, 0) }))
      .filter((scene) => Number.isFinite(scene.at))
      .sort((a, b) => b.score - a.score);

    for (const scene of rankedScenes) {
      if (transitionsToAdd <= 0) break;
      if (hasTransitionNear(baseEdits, scene.at, 1.0)) continue;
      baseEdits.push({
        type: 'transition',
        at: scene.at,
        effect: 'fade',
        duration: 0.5,
        reason: 'RAG 추천 전환',
      });
      if (baseEdits.filter((edit) => edit.type === 'transition').length >= targetTransitionCount) {
        break;
      }
    }

    const ragSourceIds = uniqueStrings((patternResult.patterns || []).map((item) => item.id)).slice(0, 5);
    const enhanced = {
      ...edl,
      edits: baseEdits.sort((a, b) => ((a.from ?? a.at ?? 0) - (b.from ?? b.at ?? 0))),
      rag_source: {
        based_on: ragSourceIds,
        confidence: patternResult.patterns.length
          ? Number(Math.min(0.9, 0.4 + (patternResult.patterns.length * 0.1)).toFixed(2))
          : 0,
        avg_processing_time_ms: safeNumber(suggestions.avg_processing_time_ms, 0),
        sample_count: safeNumber(suggestions.sample_count, 0),
        duration_minutes: Number(durationMinutes.toFixed(2)),
      },
    };
    return enhanced;
  } catch (_error) {
    return edl;
  }
}

async function estimateWithRAG(videoCount, totalSizeMb, totalDurationMin) {
  try {
    const query = `영상 ${safeNumber(videoCount, 0)}개 크기 ${safeNumber(totalSizeMb, 0)}MB 길이 ${safeNumber(totalDurationMin, 0)}분`;
    const results = await searchSimilarEdits(query, {
      limit: 5,
      threshold: 0.2,
      type: 'edit_result',
      minScore: 0,
    });
    if (!results.length) {
      return {
        estimated_ms: 0,
        estimated_cost_usd: 0,
        confidence: 'low',
        sample_count: 0,
        samples: [],
      };
    }

    let totalWeight = 0;
    let weightedMs = 0;
    let weightedCost = 0;
    const samples = results.map((item) => {
      const similarity = Math.max(0.01, safeNumber(item.similarity, 0));
      const totalMs = safeNumber(item.metadata?.total_ms, 0);
      const totalCostUsd = safeNumber(item.metadata?.total_cost_usd, 0);
      totalWeight += similarity;
      weightedMs += totalMs * similarity;
      weightedCost += totalCostUsd * similarity;
      return {
        title: item.metadata?.title || item.content,
        duration_s: safeNumber(item.metadata?.duration_s, 0),
        total_ms: totalMs,
        similarity: Number(similarity.toFixed(3)),
      };
    });

    const confidence = results.length >= 5 ? 'high' : results.length >= 3 ? 'medium' : 'low';
    return {
      estimated_ms: Math.round(weightedMs / Math.max(totalWeight, 0.01)),
      estimated_cost_usd: Number((weightedCost / Math.max(totalWeight, 0.01)).toFixed(6)),
      confidence,
      sample_count: results.length,
      samples,
    };
  } catch (_error) {
    return {
      estimated_ms: 0,
      estimated_cost_usd: 0,
      confidence: 'low',
      sample_count: 0,
      samples: [],
    };
  }
}

module.exports = {
  storeEditResult,
  storeEditFeedback,
  searchSimilarEdits,
  searchEditPatterns,
  enhanceCriticWithRAG,
  enhanceEDLWithRAG,
  estimateWithRAG,
};
