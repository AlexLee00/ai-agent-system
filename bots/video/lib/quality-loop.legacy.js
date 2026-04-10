'use strict';

const fs = require('fs');
const path = require('path');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { runCritic, saveCriticReport } = require('./critic-agent');
const { runRefiner, saveRefinerResult } = require('./refiner-agent');
const { runEvaluator, saveEvaluation } = require('./evaluator-agent');

const BOT_NAME = 'video';

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function emitProgress(callback, event) {
  if (typeof callback !== 'function') return;
  try {
    callback(event);
  } catch (_error) {
    // onProgress는 부수효과이므로 본 흐름을 막지 않는다.
  }
}

function saveLoopResult(result, outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return outputPath;
}

function findBestVersion(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  return [...history]
    .sort((a, b) => {
      const scoreDiff = safeNumber(b.score, 0) - safeNumber(a.score, 0);
      if (scoreDiff !== 0) return scoreDiff;
      return safeNumber(a.iteration, 0) - safeNumber(b.iteration, 0);
    })[0];
}

async function runQualityLoop(syncedVideoPath, subtitlePath, edlPath, analysisOrPath, config, options = {}) {
  const startedAt = Date.now();
  const tempDir = path.resolve(options.tempDir || path.join(__dirname, '..', 'temp'));
  const maxIterations = Math.max(1, safeNumber(options.maxIterations, config?.quality_loop?.max_iterations || 3));
  const targetScore = safeNumber(options.targetScore, config?.quality_loop?.target_score || 85);
  const onProgress = options.onProgress;

  ensureDirectory(tempDir);

  let currentSubtitlePath = path.resolve(subtitlePath);
  let currentEdlPath = path.resolve(edlPath);
  let currentAudioPath = null;
  let currentReport = null;
  let finalAction = 'ACCEPT_BEST';
  const history = [];
  let totalCostUsd = 0;

  try {
    emitProgress(onProgress, { type: 'critic_start', iteration: 0 });
    currentReport = await runCritic(path.resolve(syncedVideoPath), currentSubtitlePath, analysisOrPath, config);
    const criticV0Path = path.join(tempDir, 'critic_report_v0.json');
    saveCriticReport(currentReport, criticV0Path);
    totalCostUsd += safeNumber(currentReport.llm_cost_usd, 0);
    emitProgress(onProgress, { type: 'critic_done', iteration: 0, score: currentReport.score });

    history.push({
      iteration: 0,
      score: currentReport.score,
      action: currentReport.score >= targetScore ? 'PASS' : 'RETRY',
      subtitlePath: currentSubtitlePath,
      edlPath: currentEdlPath,
      audioPath: currentAudioPath,
      criticReportPath: criticV0Path,
      evaluationPath: null,
      refinerResultPath: null,
    });

    if (currentReport.score >= targetScore) {
      finalAction = 'PASS';
      const bestVersion = findBestVersion(history);
      const result = {
        iterations_run: 0,
        max_iterations: maxIterations,
        final_score: currentReport.score,
        target_score: targetScore,
        pass: true,
        best_version: {
          iteration: bestVersion.iteration,
          score: bestVersion.score,
          subtitle_path: bestVersion.subtitlePath,
          edl_path: bestVersion.edlPath,
          audio_path: bestVersion.audioPath,
        },
        history,
        total_cost_usd: Number(totalCostUsd.toFixed(6)),
        total_duration_ms: Date.now() - startedAt,
      };
      emitProgress(onProgress, {
        type: 'loop_done',
        finalScore: result.final_score,
        pass: result.pass,
        bestVersion: result.best_version,
      });
      await logToolCall('quality_loop', 'run_quality_loop', {
        bot: BOT_NAME,
        success: true,
        duration_ms: result.total_duration_ms,
        metadata: {
          iterationsRun: result.iterations_run,
          finalScore: result.final_score,
          action: finalAction,
        },
      });
      return result;
    }

    for (let iteration = 1; iteration < maxIterations; iteration += 1) {
      emitProgress(onProgress, { type: 'refiner_start', iteration });
      const refinerResult = await runRefiner(currentReport, currentSubtitlePath, currentEdlPath, config, {
        videoPath: path.resolve(syncedVideoPath),
      });
      const refinerResultPath = path.join(tempDir, `refiner_result_v${iteration}.json`);
      saveRefinerResult(refinerResult, refinerResultPath);
      totalCostUsd += safeNumber(refinerResult.cost_usd, 0);
      currentSubtitlePath = path.resolve(refinerResult.subtitle?.path || currentSubtitlePath);
      currentEdlPath = path.resolve(refinerResult.edl?.path || currentEdlPath);
      currentAudioPath = refinerResult.audio?.path ? path.resolve(refinerResult.audio.path) : null;
      emitProgress(onProgress, {
        type: 'refiner_done',
        iteration,
        changes: refinerResult.total_changes,
      });

      emitProgress(onProgress, { type: 'evaluator_start', iteration });
      const evaluation = await runEvaluator({
        ...refinerResult,
        iteration,
        previous_report: currentReport,
        analysis_path: analysisOrPath,
      }, path.resolve(syncedVideoPath), config);
      const evaluationPath = path.join(tempDir, `evaluation_v${iteration}.json`);
      saveEvaluation(evaluation, evaluationPath);
      const criticReportPath = path.join(tempDir, `critic_report_v${iteration}.json`);
      saveCriticReport(evaluation.report, criticReportPath);
      totalCostUsd += safeNumber(evaluation.cost_usd, 0);
      emitProgress(onProgress, {
        type: 'evaluator_done',
        iteration,
        score: evaluation.current_score,
        recommendation: evaluation.recommendation,
      });

      history.push({
        iteration,
        score: evaluation.current_score,
        action: evaluation.recommendation,
        subtitlePath: currentSubtitlePath,
        edlPath: currentEdlPath,
        audioPath: currentAudioPath,
        criticReportPath,
        evaluationPath,
        refinerResultPath,
      });

      currentReport = evaluation.report;

      if (evaluation.recommendation === 'PASS') {
        finalAction = 'PASS';
        break;
      }
      if (evaluation.recommendation === 'ACCEPT_BEST') {
        finalAction = 'ACCEPT_BEST';
        break;
      }
      finalAction = 'RETRY';
    }

    const bestVersion = findBestVersion(history) || history[0];
    const result = {
      iterations_run: history.length - 1,
      max_iterations: maxIterations,
      final_score: safeNumber(bestVersion?.score, safeNumber(currentReport?.score, 0)),
      target_score: targetScore,
      pass: finalAction === 'PASS',
      best_version: bestVersion ? {
        iteration: bestVersion.iteration,
        score: bestVersion.score,
        subtitle_path: bestVersion.subtitlePath,
        edl_path: bestVersion.edlPath,
        audio_path: bestVersion.audioPath,
      } : null,
      history,
      total_cost_usd: Number(totalCostUsd.toFixed(6)),
      total_duration_ms: Date.now() - startedAt,
    };

    emitProgress(onProgress, {
      type: 'loop_done',
      finalScore: result.final_score,
      pass: result.pass,
      bestVersion: result.best_version,
    });

    await logToolCall('quality_loop', 'run_quality_loop', {
      bot: BOT_NAME,
      success: true,
      duration_ms: result.total_duration_ms,
      metadata: {
        iterationsRun: result.iterations_run,
        finalScore: result.final_score,
        action: finalAction,
        bestIteration: result.best_version?.iteration ?? null,
      },
    });

    return result;
  } catch (error) {
    const bestVersion = findBestVersion(history);
    const result = {
      iterations_run: history.length ? history.length - 1 : 0,
      max_iterations: maxIterations,
      final_score: safeNumber(bestVersion?.score, safeNumber(currentReport?.score, 0)),
      target_score: targetScore,
      pass: false,
      best_version: bestVersion ? {
        iteration: bestVersion.iteration,
        score: bestVersion.score,
        subtitle_path: bestVersion.subtitlePath,
        edl_path: bestVersion.edlPath,
        audio_path: bestVersion.audioPath,
      } : null,
      history,
      total_cost_usd: Number(totalCostUsd.toFixed(6)),
      total_duration_ms: Date.now() - startedAt,
      error_message: toErrorMessage(error),
      recommendation: 'ACCEPT_BEST',
    };

    emitProgress(onProgress, {
      type: 'loop_done',
      finalScore: result.final_score,
      pass: result.pass,
      bestVersion: result.best_version,
    });

    await logToolCall('quality_loop', 'run_quality_loop', {
      bot: BOT_NAME,
      success: false,
      duration_ms: result.total_duration_ms,
      error: result.error_message,
      metadata: {
        iterationsRun: result.iterations_run,
        bestIteration: result.best_version?.iteration ?? null,
      },
    });

    return result;
  }
}

module.exports = {
  runQualityLoop,
  findBestVersion,
  saveLoopResult,
};
