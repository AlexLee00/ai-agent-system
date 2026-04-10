// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const {
  runCritic,
  analyzeAudio,
  saveCriticReport,
} = require('./critic-agent');
const { loadEDL } = require('./edl-builder');

const BOT_NAME = 'video';

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

function loadJsonMaybe(input) {
  if (typeof input === 'string') {
    return JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  }
  return input || {};
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveAnalysisInput(refinerResult, syncedVideoPath = null) {
  if (refinerResult?.analysis) return refinerResult.analysis;
  if (refinerResult?.analysis_data) return refinerResult.analysis_data;
  if (refinerResult?.analysis_path) return refinerResult.analysis_path;
  if (refinerResult?._analysisOrPath) return refinerResult._analysisOrPath;

  const candidates = [
    refinerResult?.subtitle?.path,
    refinerResult?.subtitlePath,
    refinerResult?.edl?.path,
    refinerResult?.edlPath,
    refinerResult?.audio?.path,
    refinerResult?.audioPath,
    syncedVideoPath,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const guessedPath = path.join(path.dirname(path.resolve(candidate)), 'analysis.json');
    if (fs.existsSync(guessedPath)) {
      return guessedPath;
    }
  }

  throw new Error('Evaluator에 analysis 정보가 없습니다.');
}

function normalizePathMaybe(filePath) {
  return filePath ? path.resolve(filePath) : null;
}

function getResolvedSubtitlePath(refinerResult) {
  return normalizePathMaybe(refinerResult?.subtitle?.path || refinerResult?.subtitlePath);
}

function getResolvedEtlPath(refinerResult) {
  return normalizePathMaybe(refinerResult?.edl?.path || refinerResult?.edlPath);
}

function getResolvedAudioPath(refinerResult) {
  return normalizePathMaybe(refinerResult?.audio?.path || refinerResult?.audioPath || null);
}

function hasMatchingCut(edits, issue, toleranceSeconds = 0.3) {
  return edits.some((edit) => (
    edit?.type === 'cut'
      && Math.abs(safeNumber(edit.from) - safeNumber(issue.from)) <= toleranceSeconds
      && Math.abs(safeNumber(edit.to) - safeNumber(issue.to)) <= toleranceSeconds
  ));
}

function hasMatchingTransition(edits, issue, toleranceSeconds = 1.0) {
  return edits.some((edit) => (
    edit?.type === 'transition'
      && Math.abs(safeNumber(edit.at) - safeNumber(issue.at)) <= toleranceSeconds
  ));
}

function filterResolvedIssues(report, edlPath) {
  if (!edlPath || !fs.existsSync(edlPath)) {
    return report;
  }

  const edl = loadEDL(edlPath);
  const edits = Array.isArray(edl.edits) ? edl.edits : [];
  const remainingIssues = [];

  for (const issue of report.issues || []) {
    if (issue.type === 'silent_gap' && hasMatchingCut(edits, issue)) {
      continue;
    }
    if (issue.type === 'freeze_frame' && hasMatchingCut(edits, issue)) {
      continue;
    }
    if (issue.type === 'scene_change' && hasMatchingTransition(edits, issue)) {
      continue;
    }
    if (issue.type === 'excessive_scenes') {
      const transitionCount = edits.filter((edit) => edit?.type === 'transition').length;
      const durationSeconds = safeNumber(report.analysis_summary?.duration_seconds, 0);
      const sceneDensity = durationSeconds > 0 ? transitionCount / (durationSeconds / 60) : transitionCount;
      if (sceneDensity <= 3) {
        continue;
      }
    }
    remainingIssues.push(issue);
  }

  return {
    ...report,
    issues: remainingIssues,
  };
}

async function evaluate(subtitlePath, edlPath, syncedVideoPath, analysisOrPath, config, audioPath = null) {
  const baseReport = await runCritic(syncedVideoPath, subtitlePath, analysisOrPath, config);
  let report = filterResolvedIssues(baseReport, edlPath);

  if (audioPath) {
    try {
      const audioResult = await analyzeAudio(audioPath, config);
      const nonAudioIssues = (report.issues || []).filter((issue) => !String(issue.type || '').startsWith('audio_'));
      const combinedIssues = nonAudioIssues.concat(audioResult.issues || []);
      const overall = Math.round(
        (safeNumber(report.scores?.subtitle_accuracy, 0) * 0.4)
        + (safeNumber(audioResult.score, 0) * 0.3)
        + (safeNumber(report.scores?.video_structure, 0) * 0.3)
      );
      report = {
        ...report,
        score: overall,
        pass: overall >= safeNumber(config?.quality_loop?.target_score, 85),
        issues: combinedIssues,
        scores: {
          ...report.scores,
          audio_quality: audioResult.score,
          overall,
        },
        analysis_summary: {
          ...report.analysis_summary,
          audio_lufs: audioResult.audioLufs,
          audio_peak: audioResult.audioPeak,
        },
      };
    } catch (error) {
      await logToolCall('evaluator_agent', 'evaluate_audio_override', {
        bot: BOT_NAME,
        success: false,
        duration_ms: 0,
        error: toErrorMessage(error),
        metadata: { audioPath },
      });
    }
  }

  return report;
}

function compareReports(previousReport, currentReport) {
  const previousIssues = Array.isArray(previousReport?.issues) ? previousReport.issues : [];
  const currentIssues = Array.isArray(currentReport?.issues) ? currentReport.issues : [];
  const previousScore = safeNumber(previousReport?.score, 0);
  const currentScore = safeNumber(currentReport?.score, 0);

  const signature = (issue) => JSON.stringify({
    type: issue?.type || null,
    entry: issue?.entry ?? null,
    from: safeNumber(issue?.from, null),
    to: safeNumber(issue?.to, null),
    at: safeNumber(issue?.at, null),
    action: issue?.action || null,
    current: issue?.current || null,
    fix: issue?.fix || null,
  });

  const previousMap = new Map(previousIssues.map((issue) => [signature(issue), issue]));
  const currentMap = new Map(currentIssues.map((issue) => [signature(issue), issue]));

  const improved = previousIssues.filter((issue) => !currentMap.has(signature(issue)));
  const worsened = currentIssues.filter((issue) => !previousMap.has(signature(issue)));
  const unchanged = currentIssues.filter((issue) => previousMap.has(signature(issue)));

  return {
    previous_score: previousScore,
    current_score: currentScore,
    improvement: currentScore - previousScore,
    improved_issues: improved,
    worsened_issues: worsened,
    unchanged_issues: unchanged,
  };
}

function makeRecommendation(evaluation, iteration, maxIterations) {
  if (evaluation.pass) {
    return 'PASS';
  }

  if (iteration >= (maxIterations - 1)) {
    return 'ACCEPT_BEST';
  }

  if (safeNumber(evaluation.improvement, 0) <= 0) {
    return 'ACCEPT_BEST';
  }

  return 'RETRY';
}

function saveEvaluation(evaluation, outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function runEvaluator(refinerResultOrPath, syncedVideoPath, config) {
  const startedAt = Date.now();
  const refinerResult = loadJsonMaybe(refinerResultOrPath);
  const subtitlePath = getResolvedSubtitlePath(refinerResult);
  const edlPath = getResolvedEtlPath(refinerResult);
  const audioPath = getResolvedAudioPath(refinerResult);
  const analysisOrPath = resolveAnalysisInput(refinerResult, syncedVideoPath);
  const previousReport = refinerResult.previous_report || refinerResult.previousReport || {
    score: safeNumber(refinerResult.critic_score, 0),
    issues: [],
  };
  const iteration = Number.isInteger(refinerResult.iteration)
    ? refinerResult.iteration
    : safeNumber(refinerResult.version, 1) - 1;

  const currentReport = await evaluate(
    subtitlePath,
    edlPath,
    path.resolve(syncedVideoPath),
    analysisOrPath,
    config,
    audioPath
  );
  const comparison = compareReports(previousReport, currentReport);
  const evaluation = {
    version: 1,
    timestamp: new Date().toISOString(),
    iteration,
    previous_score: comparison.previous_score,
    current_score: comparison.current_score,
    target_score: safeNumber(config?.quality_loop?.target_score, 85),
    pass: currentReport.pass,
    improvement: comparison.improvement,
    scores: currentReport.scores,
    remaining_issues: currentReport.issues,
    comparison: {
      improved_count: comparison.improved_issues.length,
      worsened_count: comparison.worsened_issues.length,
      unchanged_count: comparison.unchanged_issues.length,
      improved_issues: comparison.improved_issues,
      worsened_issues: comparison.worsened_issues,
    },
    recommendation: makeRecommendation({
      pass: currentReport.pass,
      improvement: comparison.improvement,
    }, iteration, safeNumber(config?.quality_loop?.max_iterations, 3)),
    cost_usd: Number(currentReport.llm_cost_usd || 0),
    report: currentReport,
  };

  await logToolCall('evaluator_agent', 'run_evaluator', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      iteration,
      previousScore: evaluation.previous_score,
      currentScore: evaluation.current_score,
      recommendation: evaluation.recommendation,
      subtitlePath,
      edlPath,
      audioPath,
    },
  });

  return evaluation;
}

module.exports = {
  runEvaluator,
  evaluate,
  compareReports,
  makeRecommendation,
  saveEvaluation,
};
