// @ts-nocheck
'use strict';

const express = require('express');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pgPool = require('../../../../packages/core/lib/pg-pool');
const {
  generateSteps,
  attachRedEvaluation,
  attachBlueAlternative,
  applyUserAction,
  stepsToSyncMap,
  saveSteps,
  loadSteps,
} = require(path.join(__dirname, '../../../../bots/video/lib/step-proposal-engine'));
const {
  generateCutProposals,
  getNextCutIndex,
  applyCutAction,
  summarizeCutStats,
} = require(path.join(__dirname, '../../../../bots/video/lib/cut-proposal-engine'));
const {
  createVideoStepFeedbackSession,
  getVideoFeedbackSessionForStep,
  refreshVideoStepFeedbackSession,
  replaceVideoFeedbackEdits,
  markVideoFeedbackConfirmed,
  markVideoFeedbackRejected,
  markVideoFeedbackCommitted,
} = require(path.join(__dirname, '../../../../bots/video/lib/video-feedback-service'));
const { syncMapToEDL } = require(path.join(__dirname, '../../../../bots/video/lib/sync-matcher'));
const { saveEDL, renderPreview } = require(path.join(__dirname, '../../../../bots/video/lib/edl-builder'));
const { loadConfig } = require(path.join(__dirname, '../../../../bots/video/src/index'));
const { buildMediaBinaryEnv } = require(path.join(__dirname, '../../../../bots/video/lib/media-binary-env'));

const router = express.Router();
const CONFIG = loadConfig();
const PROJECT_ROOT = path.join(__dirname, '../../../..');
const VIDEO_TEMP_ROOT = path.join(PROJECT_ROOT, 'bots/video/temp');
let ensurePhase3EditColumnsPromise = null;

function normalizeCompanyId(companyId) {
  return String(companyId || '').trim();
}

function toErrorMessage(error) {
  return error?.message || String(error || '알 수 없는 오류');
}

function sendNotFound(res, message) {
  return res.status(404).json({ error: message });
}

function streamWithRange(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    return sendNotFound(res, '파일을 찾을 수 없습니다.');
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(filePath).pipe(res);
    return undefined;
  }

  const [startRaw, endRaw] = String(range).replace(/bytes=/, '').split('-');
  const start = Number.parseInt(startRaw, 10);
  const end = endRaw ? Number.parseInt(endRaw, 10) : stat.size - 1;
  if (!Number.isFinite(start) || start < 0 || start >= stat.size) {
    res.status(416).end();
    return undefined;
  }

  const safeEnd = Number.isFinite(end) && end >= start ? Math.min(end, stat.size - 1) : stat.size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${safeEnd}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': safeEnd - start + 1,
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
  return undefined;
}

function buildEditSessionId(editId) {
  return `edit-${editId}`;
}

function parseEditSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  const match = raw.match(/^(?:edit-)?(\d+)$/);
  if (!match) {
    throw new Error(`sessionId 형식이 올바르지 않습니다: ${raw}`);
  }
  return Number(match[1]);
}

async function getEditForCompany(editId, companyId) {
  await ensurePhase3EditColumns();
  const rows = await pgPool.query(
    'public',
    `SELECT ve.*, vs.company_id, vs.title AS session_title
       FROM video_edits ve
       JOIN video_sessions vs ON vs.id = ve.session_id
      WHERE ve.id = $1
        AND vs.company_id = $2`,
    [editId, normalizeCompanyId(companyId)]
  );
  return rows[0] || null;
}

async function ensurePhase3EditColumns() {
  if (ensurePhase3EditColumnsPromise) return ensurePhase3EditColumnsPromise;
  ensurePhase3EditColumnsPromise = (async () => {
    await pgPool.run('public', `
      ALTER TABLE public.video_edits
        ADD COLUMN IF NOT EXISTS edit_mode TEXT DEFAULT 'auto'
    `);
    await pgPool.run('public', `
      ALTER TABLE public.video_edits
        ADD COLUMN IF NOT EXISTS phase3_version INTEGER DEFAULT NULL
    `);
    await pgPool.run('public', `
      ALTER TABLE public.video_edits
        ADD COLUMN IF NOT EXISTS phase3_latest_dir TEXT DEFAULT NULL
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_video_edits_mode
      ON public.video_edits(edit_mode)
    `);
  })().catch((error) => {
    ensurePhase3EditColumnsPromise = null;
    throw error;
  });
  return ensurePhase3EditColumnsPromise;
}

function getSessionDir(traceId) {
  return path.join(VIDEO_TEMP_ROOT, `run-${String(traceId || '').slice(0, 8)}`);
}

function listPhase3Versions(edit) {
  const sessionDir = getSessionDir(edit.trace_id);
  if (!fs.existsSync(sessionDir)) return [];
  return fs.readdirSync(sessionDir)
    .map((name) => {
      const match = name.match(new RegExp(`^phase3-${edit.id}-v(\\d+)$`));
      return match ? Number(match[1]) : 0;
    })
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
}

function migrateLegacyPhase3DirIfNeeded(edit) {
  const sessionDir = getSessionDir(edit.trace_id);
  if (!fs.existsSync(sessionDir)) return;

  const legacyDir = path.join(sessionDir, `phase3-${edit.id}`);
  const v1Dir = path.join(sessionDir, `phase3-${edit.id}-v1`);
  if (fs.existsSync(legacyDir) && !fs.existsSync(v1Dir)) {
    fs.renameSync(legacyDir, v1Dir);
  }
}

function getNextPhase3Version(edit) {
  migrateLegacyPhase3DirIfNeeded(edit);
  const versions = listPhase3Versions(edit);
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

function getLatestPhase3Version(edit) {
  migrateLegacyPhase3DirIfNeeded(edit);
  const versions = listPhase3Versions(edit);
  if (edit?.phase3_version && Number(edit.phase3_version) > 0) {
    return Number(edit.phase3_version);
  }
  return versions.length > 0 ? Math.max(...versions) : 1;
}

function getPhase3Dir(edit, version = null) {
  const resolvedVersion = version == null ? getLatestPhase3Version(edit) : Number(version);
  return path.join(getSessionDir(edit.trace_id), `phase3-${edit.id}-v${resolvedVersion}`);
}

function getWorkflowPaths(edit, version = null) {
  const sessionDir = getSessionDir(edit.trace_id);
  const phase3Dir = getPhase3Dir(edit, version);
  const stepsPath = path.join(phase3Dir, 'steps.json');
  const statePath = path.join(phase3Dir, 'session.json');
  return {
    sessionDir,
    phase3Dir,
    stepsPath,
    statePath,
    syncMapPath: path.join(sessionDir, 'sync_map.json'),
    sceneIndexPath: path.join(sessionDir, 'scene_index.json'),
    normalizedAudioPath: path.join(sessionDir, 'narr_norm.m4a'),
    subtitleTimelinePath: path.join(sessionDir, 'subtitle_timeline.srt'),
    edlPath: path.join(phase3Dir, 'edit_decision_list.phase3.json'),
    previewPath: path.join(phase3Dir, 'preview.phase3.mp4'),
  };
}

function getCutReviewPaths(edit) {
  const sessionDir = getSessionDir(edit.trace_id);
  return {
    sessionDir,
    cutStatePath: path.join(sessionDir, `cut-review-${edit.id}.json`),
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePlayableVideoPath(edit) {
  const candidatePaths = [];
  if (edit.raw_video_path) candidatePaths.push(edit.raw_video_path);
  try {
    const state = loadWorkflowState(edit);
    const previewPath = state.previewPath || getWorkflowPaths(edit, state.version).previewPath;
    if (previewPath) candidatePaths.push(previewPath);
  } catch (_error) {
    // 컷/효과 단계에서는 워크플로우 상태가 아직 없을 수 있음
  }
  return candidatePaths.find((filePath) => filePath && fs.existsSync(filePath)) || null;
}

function getFramePreviewPath(edit, seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const frameDir = path.join(getSessionDir(edit.trace_id), 'frame-previews');
  ensureDirectory(frameDir);
  const frameKey = String(Math.round(safeSeconds * 1000)).padStart(8, '0');
  return path.join(frameDir, `edit-${edit.id}-${frameKey}.jpg`);
}

function ensureFramePreview(edit, seconds) {
  const playablePath = resolvePlayableVideoPath(edit);
  if (!playablePath) {
    throw new Error('프레임 추출용 영상을 찾을 수 없습니다.');
  }

  const outputPath = getFramePreviewPath(edit, seconds);
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const ffmpegArgs = [
    '-ss',
    String(Math.max(0, seconds)),
    '-i',
    playablePath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    outputPath,
  ];
  const result = spawnSync('ffmpeg', ffmpegArgs, {
    env: buildMediaBinaryEnv(process.env),
    encoding: 'utf8',
  });
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error((result.stderr || result.stdout || '프레임 추출 실패').trim());
  }
  return outputPath;
}

function saveWorkflowState(edit, payload, options = {}) {
  const version = options.version ?? payload?.version ?? null;
  const paths = options.paths || getWorkflowPaths(edit, version);
  ensureDirectory(paths.phase3Dir);
  fs.writeFileSync(paths.statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadWorkflowState(edit) {
  const paths = getWorkflowPaths(edit);
  if (!fs.existsSync(paths.statePath) || !fs.existsSync(paths.stepsPath)) {
    throw new Error(`스텝 세션을 찾을 수 없습니다: ${buildEditSessionId(edit.id)}`);
  }
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  const steps = loadSteps(paths.stepsPath);
  return { ...state, steps };
}

function buildCutSessionId(editId) {
  return `cut-edit-${editId}`;
}

function buildEffectSessionId(editId) {
  return `effect-edit-${editId}`;
}

function parseCutSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  const match = raw.match(/^cut-(?:edit-)?(\d+)$/);
  if (!match) {
    throw new Error(`cut sessionId 형식이 올바르지 않습니다: ${raw}`);
  }
  return Number(match[1]);
}

function parseEffectSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  const match = raw.match(/^effect-(?:edit-)?(\d+)$/);
  if (!match) {
    throw new Error(`effect sessionId 형식이 올바르지 않습니다: ${raw}`);
  }
  return Number(match[1]);
}

function saveCutState(edit, payload) {
  const paths = getCutReviewPaths(edit);
  ensureDirectory(paths.sessionDir);
  fs.writeFileSync(paths.cutStatePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadCutState(edit) {
  const paths = getCutReviewPaths(edit);
  if (!fs.existsSync(paths.cutStatePath)) {
    throw new Error(`컷 편집 세션을 찾을 수 없습니다: ${buildCutSessionId(edit.id)}`);
  }
  return JSON.parse(fs.readFileSync(paths.cutStatePath, 'utf8'));
}

function tryLoadCutState(edit) {
  try {
    return loadCutState(edit);
  } catch (_error) {
    return null;
  }
}

function getEffectReviewPaths(edit) {
  const sessionDir = getSessionDir(edit.trace_id);
  return {
    sessionDir,
    effectStatePath: path.join(sessionDir, `effect-review-${edit.id}.json`),
  };
}

function saveEffectState(edit, payload) {
  const paths = getEffectReviewPaths(edit);
  ensureDirectory(paths.sessionDir);
  fs.writeFileSync(paths.effectStatePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadEffectState(edit) {
  const paths = getEffectReviewPaths(edit);
  if (!fs.existsSync(paths.effectStatePath)) {
    throw new Error(`효과 편집 세션을 찾을 수 없습니다: ${buildEffectSessionId(edit.id)}`);
  }
  return JSON.parse(fs.readFileSync(paths.effectStatePath, 'utf8'));
}

function tryLoadEffectState(edit) {
  try {
    return loadEffectState(edit);
  } catch (_error) {
    return null;
  }
}

function getNextStepIndex(steps) {
  const nextIndex = steps.findIndex((step) => !step.user_action);
  return nextIndex === -1 ? Math.max(0, steps.length - 1) : nextIndex;
}

function getPreviewUrl(editId) {
  return `/api/video/steps/edit-${editId}/preview?t=${Date.now()}`;
}

function summarizeStats(steps) {
  return ensureArray(steps).reduce((acc, step) => {
    if (step.user_action === 'confirm') acc.confirmed += 1;
    else if (step.user_action === 'modify') acc.modified += 1;
    else if (step.user_action === 'skip') acc.skipped += 1;
    else if (step.user_action === 'adopt_blue') acc.adoptedBlue += 1;
    return acc;
  }, {
    confirmed: 0,
    modified: 0,
    skipped: 0,
    adoptedBlue: 0,
  });
}

function buildCutReviewMessage(items) {
  const total = ensureArray(items).length;
  if (total <= 0) {
    return '불필요 구간 후보를 찾지 못했습니다. 그대로 다음 단계로 진행할 수 있어요.';
  }
  return `불필요 구간 편집을 제안합니다. 총 ${total}개의 삭제 후보를 찾았습니다.`;
}

function buildEffectReviewMessage(items) {
  const total = ensureArray(items).length;
  if (total <= 0) {
    return '효과를 꼭 삽입할 구간은 찾지 못했습니다. 그대로 다음 단계로 진행할 수 있어요.';
  }
  return `효과 삽입을 제안합니다. 총 ${total}개의 효과 후보를 검토해주세요.`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildEffectDescriptor(step) {
  const narration = step?.proposal?.narration || {};
  const source = step?.proposal?.source || {};
  const duration = Math.max(0, Number(narration.end_s || 0) - Number(narration.start_s || 0));
  let effectType = 'zoom';
  if (String(source.scene_type || '').includes('transition')) effectType = 'slide';
  else if (duration <= 2.5) effectType = 'flash';
  else if (duration <= 4) effectType = 'pointer';
  else if (String(source.description || '').match(/버튼|입력|클릭|설정/)) effectType = 'pointer';
  else if (String(source.description || '').match(/표|리스트|메뉴/)) effectType = 'highlight';

  const labelMap = {
    zoom: '확대',
    pointer: '포인터',
    slide: '슬라이드',
    highlight: '하이라이트',
    flash: '강조 플래시',
  };

  return {
    effect_type: effectType,
    effect_label: labelMap[effectType] || '효과 삽입',
    intensity: effectType === 'flash' ? 'medium' : effectType === 'zoom' ? 'soft' : 'normal',
    target_hint: narration.topic || source.description || step?.proposal?.reason || '핵심 구간 강조',
  };
}

function getConfirmedCutSegments(cutState) {
  return ensureArray(cutState?.items)
    .filter((item) => ['confirm', 'modify'].includes(String(item.user_action || '')) && item.final)
    .map((item) => ({
      startMs: Number(item.final.start_ms ?? item.proposal_start_ms ?? 0),
      endMs: Number(item.final.end_ms ?? item.proposal_end_ms ?? 0),
      reason: item.final.reason_text || item.reason_text || '컷 편집 확정 구간',
    }))
    .filter((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

function splitClipAgainstCuts(clip, confirmedCuts = []) {
  if (!clip || clip.clip_type !== 'main' || !confirmedCuts.length) {
    return [clip];
  }

  const clipStartMs = Math.round(Number(clip.source_start || 0) * 1000);
  const clipEndMs = Math.round(Number(clip.source_end || 0) * 1000);
  const clipDurationMs = Math.max(0, clipEndMs - clipStartMs);
  if (clipDurationMs <= 0) return [];

  const overlappingCuts = confirmedCuts
    .filter((cut) => cut.endMs > clipStartMs && cut.startMs < clipEndMs)
    .map((cut) => ({
      startMs: Math.max(clipStartMs, cut.startMs),
      endMs: Math.min(clipEndMs, cut.endMs),
      reason: cut.reason,
    }))
    .sort((a, b) => a.startMs - b.startMs);

  if (!overlappingCuts.length) {
    return [clip];
  }

  const keepRanges = [];
  let cursorMs = clipStartMs;
  for (const cut of overlappingCuts) {
    if (cut.startMs > cursorMs) {
      keepRanges.push({ startMs: cursorMs, endMs: cut.startMs });
    }
    cursorMs = Math.max(cursorMs, cut.endMs);
  }
  if (cursorMs < clipEndMs) {
    keepRanges.push({ startMs: cursorMs, endMs: clipEndMs });
  }

  let timelineCursor = Number(clip.timeline_start || 0);
  const narrationStart = Number(clip.narration_start || 0);
  const narrationEnd = Number(clip.narration_end || narrationStart);
  const narrationDuration = Math.max(0, narrationEnd - narrationStart);
  const sourceDurationSec = clipDurationMs / 1000;

  return keepRanges
    .filter((range) => range.endMs - range.startMs >= 300)
    .map((range, index) => {
      const keepDurationSec = (range.endMs - range.startMs) / 1000;
      const sourceOffsetSec = (range.startMs - clipStartMs) / 1000;
      const audioStart = narrationStart + Math.min(sourceOffsetSec, narrationDuration);
      const audioEnd = Math.min(narrationEnd, audioStart + keepDurationSec);
      const nextClip = {
        ...clip,
        source_start: Number((range.startMs / 1000).toFixed(3)),
        source_end: Number((range.endMs / 1000).toFixed(3)),
        timeline_start: Number(timelineCursor.toFixed(3)),
        timeline_end: Number((timelineCursor + keepDurationSec).toFixed(3)),
        audio_start: Number(audioStart.toFixed(3)),
        audio_end: Number(Math.max(audioStart, audioEnd).toFixed(3)),
        narration_duration: Number(Math.max(0, Math.min(keepDurationSec, narrationDuration - Math.min(sourceOffsetSec, narrationDuration))).toFixed(3)),
        timeline_duration: Number(keepDurationSec.toFixed(3)),
        cut_segment_index: index,
      };
      timelineCursor += keepDurationSec;
      return nextClip;
    });
}

function applyConfirmedCutsToEdl(edl, confirmedCuts = []) {
  if (!edl || !Array.isArray(edl.clips) || !confirmedCuts.length) {
    return edl;
  }

  const nextClips = [];
  let timelineCursor = 0;
  for (const clip of edl.clips) {
    const parts = splitClipAgainstCuts(clip, confirmedCuts);
    if (!parts.length) continue;
    for (const part of parts) {
      const duration = Math.max(0, Number(part.timeline_end || 0) - Number(part.timeline_start || 0));
      if (duration <= 0) continue;
      nextClips.push({
        ...part,
        timeline_start: Number(timelineCursor.toFixed(3)),
        timeline_end: Number((timelineCursor + duration).toFixed(3)),
      });
      timelineCursor += duration;
    }
  }

  return {
    ...edl,
    duration: Number(timelineCursor.toFixed(3)),
    clips: nextClips,
    edits: [
      ...ensureArray(edl.edits),
      ...confirmedCuts.map((cut) => ({
        type: 'cut',
        from: Number((cut.startMs / 1000).toFixed(3)),
        to: Number((cut.endMs / 1000).toFixed(3)),
        reason: cut.reason,
      })),
    ],
  };
}

function applyConfirmedCutsToSyncMap(syncMap, confirmedCuts = []) {
  if (!syncMap || !ensureArray(syncMap.matches).length || !confirmedCuts.length) {
    return syncMap;
  }

  const adjustedMatches = [];
  for (const match of ensureArray(syncMap.matches)) {
    const source = match?.source;
    if (!source) {
      adjustedMatches.push(match);
      continue;
    }

    const sourceStartMs = Math.round(Number(source.start_s || 0) * 1000);
    const sourceEndMs = Math.round(Number(source.end_s || 0) * 1000);
    if (sourceEndMs <= sourceStartMs) {
      adjustedMatches.push(match);
      continue;
    }

    const overlaps = confirmedCuts
      .filter((cut) => cut.endMs > sourceStartMs && cut.startMs < sourceEndMs)
      .sort((a, b) => a.startMs - b.startMs);

    if (!overlaps.length) {
      adjustedMatches.push(match);
      continue;
    }

    let removedMs = 0;
    for (const cut of overlaps) {
      const overlapStart = Math.max(sourceStartMs, cut.startMs);
      const overlapEnd = Math.min(sourceEndMs, cut.endMs);
      removedMs += Math.max(0, overlapEnd - overlapStart);
    }

    const nextSourceEndMs = Math.max(sourceStartMs + 300, sourceEndMs - removedMs);
    const sourceDurationSec = Math.max(0.3, (nextSourceEndMs - sourceStartMs) / 1000);
    const narrationStart = Number(match.narration_start_s ?? match.narration?.start_s ?? 0);
    const narrationEnd = Number(match.narration_end_s ?? match.narration?.end_s ?? narrationStart);
    const narrationDurationSec = Math.max(0.3, narrationEnd - narrationStart);
    const nextSpeedFactor = Number((sourceDurationSec / narrationDurationSec).toFixed(4));

    adjustedMatches.push({
      ...match,
      source: {
        ...source,
        start_s: Number((sourceStartMs / 1000).toFixed(3)),
        end_s: Number((nextSourceEndMs / 1000).toFixed(3)),
      },
      speed_factor: nextSpeedFactor,
      cut_adjusted: true,
      cut_removed_ms: removedMs,
    });
  }

  const overallConfidence = adjustedMatches.length
    ? Number((adjustedMatches.reduce((sum, item) => sum + Number(item.match_score || 0), 0) / adjustedMatches.length).toFixed(4))
    : 0;

  return {
    ...syncMap,
    matches: adjustedMatches,
    overall_confidence: overallConfidence,
    cut_adjusted: true,
    confirmed_cut_count: confirmedCuts.length,
  };
}

async function ensureFeedbackSessionForStep(edit, step) {
  const sourceRefId = `edit:${edit.id}:step:${step.step_index}`;
  const existing = await getVideoFeedbackSessionForStep(sourceRefId);
  if (existing) {
    const activeStatuses = new Set(['pending', 'confirmed']);
    if (activeStatuses.has(String(existing.feedback_status || '').toLowerCase())) {
      return refreshVideoStepFeedbackSession({
        sessionId: existing.id,
        originalSnapshot: step.proposal,
        aiOutputType: 'step_proposal',
        actionCode: step.step_type,
      });
    }
  }
  return createVideoStepFeedbackSession({
    companyId: edit.company_id,
    sourceType: 'video_edit',
    sourceRefType: 'edit_step',
    sourceRefId,
    flowCode: 'video_edit',
    actionCode: step.step_type,
    aiOutputType: 'step_proposal',
    originalSnapshot: step.proposal,
    eventMeta: {
      editId: edit.id,
      sessionId: edit.session_id,
      stepIndex: step.step_index,
    },
  });
}

router.post('/generate', async (req, res) => {
  try {
    const editId = Number.parseInt(req.body?.editId, 10);
    if (!editId) {
      return res.status(400).json({ error: 'editId는 필수입니다.' });
    }

    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    if (!edit.trace_id) {
      return res.status(400).json({ error: 'trace_id가 없어 세션 산출물을 찾을 수 없습니다.' });
    }

    const paths = getWorkflowPaths(edit);
    if (!fs.existsSync(paths.syncMapPath)) {
      return sendNotFound(res, `sync_map.json을 찾을 수 없습니다: ${paths.syncMapPath}`);
    }

    const syncMap = JSON.parse(fs.readFileSync(paths.syncMapPath, 'utf8'));
    const sceneIndex = fs.existsSync(paths.sceneIndexPath)
      ? JSON.parse(fs.readFileSync(paths.sceneIndexPath, 'utf8'))
      : { scenes: [] };
    const cutState = tryLoadCutState(edit);
    const effectState = tryLoadEffectState(edit);
    const confirmedCuts = getConfirmedCutSegments(cutState);
    const cutAdjustedSyncMap = applyConfirmedCutsToSyncMap(syncMap, confirmedCuts);

    let steps = generateSteps(cutAdjustedSyncMap, CONFIG, {});
    const shouldSkipTransition = String(effectState?.phase || '') === 'effect-confirmed';
    steps = steps.filter((step) => step.step_type !== 'cut' && (!shouldSkipTransition || step.step_type !== 'transition'));
    steps = await attachRedEvaluation(steps, CONFIG);
    steps = await attachBlueAlternative(steps, sceneIndex, CONFIG);

    for (const step of steps) {
      const feedbackSession = await ensureFeedbackSessionForStep(edit, step);
      step.feedbackSessionId = feedbackSession.id;
      if (step.auto_confirm) {
        step.user_action = 'confirm';
        step.final = { ...step.proposal };
        await markVideoFeedbackConfirmed({
          sessionId: step.feedbackSessionId,
          submittedSnapshot: step.final,
        });
      }
    }

    const version = getNextPhase3Version(edit);
    const versionedPaths = getWorkflowPaths(edit, version);

    ensureDirectory(versionedPaths.phase3Dir);
    saveSteps(steps, versionedPaths.phase3Dir);
    saveWorkflowState(edit, {
      sessionId: buildEditSessionId(edit.id),
      editId: edit.id,
      phase: 'steps',
      version,
      currentStepIndex: getNextStepIndex(steps),
      cutReviewApplied: confirmedCuts.length > 0,
      cutReviewStats: {
        confirmedCutCount: confirmedCuts.length,
        adjustedMatchCount: ensureArray(cutAdjustedSyncMap?.matches).filter((match) => match.cut_adjusted).length,
      },
      effectReviewApplied: shouldSkipTransition,
      generatedAt: new Date().toISOString(),
    }, { paths: versionedPaths });
    await pgPool.run('public', `
      UPDATE public.video_edits
      SET edit_mode = 'interactive',
          phase3_version = $2,
          phase3_latest_dir = $3
      WHERE id = $1
    `, [edit.id, version, versionedPaths.phase3Dir]);

    return res.json({
      sessionId: buildEditSessionId(edit.id),
      steps,
      autoConfirmedCount: steps.filter((step) => step.auto_confirm).length,
      manualCount: steps.filter((step) => !step.auto_confirm).length,
      currentStepIndex: getNextStepIndex(steps),
    });
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/cut/generate', async (req, res) => {
  try {
    const editId = Number.parseInt(req.body?.editId, 10);
    if (!editId) {
      return res.status(400).json({ error: 'editId는 필수입니다.' });
    }

    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    if (!edit.trace_id) {
      return res.status(400).json({ error: 'trace_id가 없어 컷 제안 산출물을 찾을 수 없습니다.' });
    }

    const paths = getWorkflowPaths(edit);
    if (!fs.existsSync(paths.sceneIndexPath)) {
      return sendNotFound(res, `scene_index.json을 찾을 수 없습니다: ${paths.sceneIndexPath}`);
    }

    const sceneIndex = JSON.parse(fs.readFileSync(paths.sceneIndexPath, 'utf8'));
    const syncMap = fs.existsSync(paths.syncMapPath)
      ? JSON.parse(fs.readFileSync(paths.syncMapPath, 'utf8'))
      : { matches: [] };

    const items = generateCutProposals(sceneIndex, syncMap);
    const currentItemIndex = getNextCutIndex(items);

    saveCutState(edit, {
      sessionId: buildCutSessionId(edit.id),
      editId: edit.id,
      phase: 'cut-review',
      generatedAt: new Date().toISOString(),
      currentItemIndex,
      items,
    });

    return res.json({
      sessionId: buildCutSessionId(edit.id),
      phase: 'cut-review',
      items,
      currentItemIndex,
      message: buildCutReviewMessage(items),
      stats: summarizeCutStats(items),
    });
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/cut/:sessionId/action', async (req, res) => {
  try {
    const editId = parseCutSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const { itemIndex, action, modification } = req.body || {};
    const state = loadCutState(edit);
    const updatedItem = applyCutAction(state.items, Number(itemIndex), action, modification || null);
    const nextItemIndex = getNextCutIndex(state.items);

    saveCutState(edit, {
      ...state,
      phase: 'cut-review',
      currentItemIndex: nextItemIndex,
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      item: updatedItem,
      items: state.items,
      currentItemIndex: nextItemIndex,
      phase: 'cut-review',
      stats: summarizeCutStats(state.items),
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/cut/:sessionId/confirm', async (req, res) => {
  try {
    const editId = parseCutSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadCutState(edit);
    const nextItemIndex = getNextCutIndex(state.items);
    saveCutState(edit, {
      ...state,
      phase: 'cut-confirmed',
      currentItemIndex: nextItemIndex,
      confirmedAt: new Date().toISOString(),
    });

    return res.json({
      sessionId: state.sessionId,
      phase: 'cut-confirmed',
      items: state.items,
      currentItemIndex: nextItemIndex,
      stats: summarizeCutStats(state.items),
      message: '컷 편집 검토를 마쳤습니다. 다음 단계 제안을 생성합니다.',
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/cut/:sessionId', async (req, res) => {
  try {
    const editId = parseCutSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadCutState(edit);
    return res.json({
      items: state.items,
      currentItemIndex: Number(state.currentItemIndex ?? getNextCutIndex(state.items)),
      phase: state.phase || 'cut-review',
      stats: summarizeCutStats(state.items),
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/effect/generate', async (req, res) => {
  try {
    const editId = Number.parseInt(req.body?.editId, 10);
    if (!editId) {
      return res.status(400).json({ error: 'editId는 필수입니다.' });
    }

    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    if (!edit.trace_id) {
      return res.status(400).json({ error: 'trace_id가 없어 효과 제안 산출물을 찾을 수 없습니다.' });
    }

    const paths = getWorkflowPaths(edit);
    if (!fs.existsSync(paths.syncMapPath)) {
      return sendNotFound(res, `sync_map.json을 찾을 수 없습니다: ${paths.syncMapPath}`);
    }
    const syncMap = JSON.parse(fs.readFileSync(paths.syncMapPath, 'utf8'));
    const sceneIndex = fs.existsSync(paths.sceneIndexPath)
      ? JSON.parse(fs.readFileSync(paths.sceneIndexPath, 'utf8'))
      : { scenes: [] };
    const cutState = tryLoadCutState(edit);
    const confirmedCuts = getConfirmedCutSegments(cutState);
    const cutAdjustedSyncMap = applyConfirmedCutsToSyncMap(syncMap, confirmedCuts);

    let items = generateSteps(cutAdjustedSyncMap, CONFIG, {});
    items = items.filter((step) => step.step_type === 'transition');
    items = await attachRedEvaluation(items, CONFIG);
    items = await attachBlueAlternative(items, sceneIndex, CONFIG);
    items = items.map((item) => ({
      ...item,
      effect: buildEffectDescriptor(item),
    }));
    const currentItemIndex = getNextStepIndex(items);

    saveEffectState(edit, {
      sessionId: buildEffectSessionId(edit.id),
      editId: edit.id,
      phase: 'effect-review',
      generatedAt: new Date().toISOString(),
      currentItemIndex,
      items,
      stats: summarizeStats(items),
    });

    return res.json({
      sessionId: buildEffectSessionId(edit.id),
      phase: 'effect-review',
      items,
      currentItemIndex,
      message: buildEffectReviewMessage(items),
      stats: summarizeStats(items),
    });
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/effect/:sessionId/action', async (req, res) => {
  try {
    const editId = parseEffectSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const { itemIndex, action, modification } = req.body || {};
    const state = loadEffectState(edit);
    const updatedItem = applyUserAction(state.items, Number(itemIndex), action, modification || null);
    const nextItemIndex = getNextStepIndex(state.items);

    saveEffectState(edit, {
      ...state,
      phase: 'effect-review',
      currentItemIndex: nextItemIndex,
      updatedAt: new Date().toISOString(),
      stats: summarizeStats(state.items),
    });

    return res.json({
      item: updatedItem,
      items: state.items,
      currentItemIndex: nextItemIndex,
      phase: 'effect-review',
      stats: summarizeStats(state.items),
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/effect/:sessionId/confirm', async (req, res) => {
  try {
    const editId = parseEffectSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadEffectState(edit);
    const nextItemIndex = getNextStepIndex(state.items);
    saveEffectState(edit, {
      ...state,
      phase: 'effect-confirmed',
      currentItemIndex: nextItemIndex,
      confirmedAt: new Date().toISOString(),
      stats: summarizeStats(state.items),
    });

    return res.json({
      sessionId: state.sessionId,
      phase: 'effect-confirmed',
      items: state.items,
      currentItemIndex: nextItemIndex,
      stats: summarizeStats(state.items),
      message: '효과 삽입 검토를 마쳤습니다. 다음 편집 단계 제안을 생성합니다.',
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/effect/:sessionId', async (req, res) => {
  try {
    const editId = parseEffectSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadEffectState(edit);
    return res.json({
      items: state.items,
      currentItemIndex: Number(state.currentItemIndex ?? getNextStepIndex(state.items)),
      phase: state.phase || 'effect-review',
      stats: summarizeStats(state.items),
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/:sessionId/action', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const { stepIndex, action, modification } = req.body || {};
      const state = loadWorkflowState(edit);
      const updatedStep = applyUserAction(state.steps, Number(stepIndex), action, modification || null);

    if (!updatedStep.feedbackSessionId) {
      throw new Error(`feedback_session_id=${updatedStep.feedbackSessionId} 를 찾을 수 없습니다.`);
    }

    if (action === 'confirm') {
      await markVideoFeedbackConfirmed({
        sessionId: updatedStep.feedbackSessionId,
        submittedSnapshot: updatedStep.final,
      });
    } else if (action === 'modify') {
      await replaceVideoFeedbackEdits({
        sessionId: updatedStep.feedbackSessionId,
        submittedSnapshot: updatedStep.final,
        eventMeta: { action: 'modify', stepIndex: updatedStep.step_index },
      });
      await markVideoFeedbackConfirmed({
        sessionId: updatedStep.feedbackSessionId,
        submittedSnapshot: updatedStep.final,
      });
    } else if (action === 'skip') {
      await markVideoFeedbackRejected({
        sessionId: updatedStep.feedbackSessionId,
        submittedSnapshot: null,
      });
    } else if (action === 'adopt_blue') {
      await markVideoFeedbackConfirmed({
        sessionId: updatedStep.feedbackSessionId,
        submittedSnapshot: updatedStep.final,
      });
    }

    const nextStepIndex = getNextStepIndex(state.steps);
    saveSteps(state.steps, getWorkflowPaths(edit).phase3Dir);
    saveWorkflowState(edit, {
      ...state,
      phase: 'steps',
      currentStepIndex: nextStepIndex,
    }, { version: state.version });

    return res.json({
      step: updatedStep,
      steps: state.steps,
      nextStepIndex,
      phase: 'steps',
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/:sessionId/finalize', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadWorkflowState(edit);
    const paths = getWorkflowPaths(edit, state.version);
    const confirmedSyncMap = stepsToSyncMap(state.steps);
    const narrationAudioPath = fs.existsSync(paths.normalizedAudioPath)
      ? paths.normalizedAudioPath
      : edit.raw_audio_path;

    const edl = syncMapToEDL(
      confirmedSyncMap,
      edit.raw_video_path,
      narrationAudioPath,
      state.introClip || null,
      state.outroClip || null,
      CONFIG
    );
    const cutState = tryLoadCutState(edit);
    const confirmedCuts = getConfirmedCutSegments(cutState);
    const nextEdl = applyConfirmedCutsToEdl(edl, confirmedCuts);
    if (fs.existsSync(paths.subtitleTimelinePath)) {
      nextEdl.subtitle = paths.subtitleTimelinePath;
    }

    saveEDL(nextEdl, paths.edlPath);
    await renderPreview(nextEdl, paths.previewPath, CONFIG);

    for (const step of state.steps.filter((item) => item.user_action && item.user_action !== 'skip' && item.feedbackSessionId)) {
      await markVideoFeedbackCommitted({
        sessionId: step.feedbackSessionId,
        submittedSnapshot: step.final,
      });
    }

    const nextStepIndex = getNextStepIndex(state.steps);
    saveSteps(state.steps, paths.phase3Dir);
    saveWorkflowState(edit, {
      ...state,
      phase: 'preview',
      currentStepIndex: nextStepIndex,
      edlPath: paths.edlPath,
      previewPath: paths.previewPath,
      confirmedCutCount: confirmedCuts.length,
      finalizedAt: new Date().toISOString(),
    }, { paths });

    return res.json({
      edlPath: paths.edlPath,
      previewPath: paths.previewPath,
      previewUrl: getPreviewUrl(edit.id),
      steps: state.steps,
      currentStepIndex: nextStepIndex,
      stats: summarizeStats(state.steps),
    });
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/:sessionId/preview', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadWorkflowState(edit);
    const previewPath = state.previewPath || getWorkflowPaths(edit, state.version).previewPath;
    if (!previewPath || !fs.existsSync(previewPath)) {
      return sendNotFound(res, 'Phase 3 프리뷰 파일을 찾을 수 없습니다.');
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    return fs.createReadStream(previewPath).pipe(res);
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/:sessionId/source-video', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    const playablePath = resolvePlayableVideoPath(edit);
    if (!playablePath) {
      return sendNotFound(res, '재생 가능한 원본 또는 프리뷰 영상을 찾을 수 없습니다.');
    }
    return streamWithRange(req, res, playablePath, 'video/mp4');
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/:sessionId/frame-preview', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const at = Number.parseFloat(String(req.query.at || '0'));
    const previewPath = ensureFramePreview(edit, Number.isFinite(at) ? at : 0);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    return fs.createReadStream(previewPath).pipe(res);
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/:sessionId', async (req, res) => {
  try {
    const editId = parseEditSessionId(req.params.sessionId);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    const state = loadWorkflowState(edit);
    return res.json({
      steps: state.steps,
      currentStepIndex: Number(state.currentStepIndex ?? getNextStepIndex(state.steps)),
      phase: state.phase || 'idle',
      previewUrl: state.previewPath ? getPreviewUrl(edit.id) : null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const status = message.includes('찾') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
