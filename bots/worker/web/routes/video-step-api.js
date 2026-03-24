'use strict';

const express = require('express');
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

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
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

    let steps = generateSteps(syncMap, CONFIG, {});
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
    if (fs.existsSync(paths.subtitleTimelinePath)) {
      edl.subtitle = paths.subtitleTimelinePath;
    }

    saveEDL(edl, paths.edlPath);
    await renderPreview(edl, paths.previewPath, CONFIG);

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
