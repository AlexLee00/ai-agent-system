'use strict';

const express = require('express');
const { fork } = require('child_process');
const path = require('path');

const { loadConfig } = require('../../../video/src/index');

const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, '../../../..');
const VIDEO_RUN_PIPELINE = path.join(PROJECT_ROOT, 'bots/video/scripts/run-pipeline.js');
const VIDEO_RENDER_FROM_EDL = path.join(PROJECT_ROOT, 'bots/video/scripts/render-from-edl.js');
const VIDEO_CONFIG = loadConfig();

function resolveVideoToken() {
  const raw = String(VIDEO_CONFIG?.n8n?.token || '').trim();
  if (!raw || raw === '${VIDEO_N8N_TOKEN}') {
    return process.env.VIDEO_N8N_TOKEN || '';
  }
  return raw;
}

function ensureAuthorized(req, res) {
  const expectedToken = resolveVideoToken();
  if (!expectedToken) {
    res.status(503).json({ ok: false, error: 'video_n8n_token_missing' });
    return false;
  }

  const providedToken = String(req.get('X-Video-Token') || '');
  if (!providedToken || providedToken !== expectedToken) {
    res.status(403).json({ ok: false, error: 'invalid_video_token' });
    return false;
  }

  return true;
}

function runPipelineDirect({ sessionId, pairIndex, videoPath, audioPath }) {
  const child = fork(VIDEO_RUN_PIPELINE, [
    `--source-video=${videoPath}`,
    `--source-audio=${audioPath}`,
    `--session-id=${sessionId}`,
    `--pair-index=${pairIndex}`,
    '--skip-render',
  ], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

function runRenderDirect(editId) {
  const child = fork(VIDEO_RENDER_FROM_EDL, [`--edit-id=${editId}`], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

router.post('/run-pipeline', (req, res) => {
  if (!ensureAuthorized(req, res)) return;

  const isHealthProbe = req.get('x-health-probe') === '1' || Boolean(req.body?._healthProbe);
  if (isHealthProbe) {
    res.json({ ok: true, status: 'probe_ok' });
    return;
  }

  const sessionId = Number.parseInt(req.body?.sessionId, 10);
  const pairIndex = Number.parseInt(req.body?.pairIndex, 10);
  const sourceVideoPath = String(req.body?.sourceVideoPath || '');
  const sourceAudioPath = String(req.body?.sourceAudioPath || '');

  if (!sessionId || !pairIndex || !sourceVideoPath || !sourceAudioPath) {
    res.status(400).json({ ok: false, error: 'missing_pipeline_payload' });
    return;
  }

  const result = runPipelineDirect({
    sessionId,
    pairIndex,
    videoPath: sourceVideoPath,
    audioPath: sourceAudioPath,
  });

  res.json({
    ok: true,
    status: 'preview_started',
    sessionId,
    pairIndex,
    pid: result.pid,
  });
});

router.post('/render-from-edl', (req, res) => {
  if (!ensureAuthorized(req, res)) return;

  const isHealthProbe = req.get('x-health-probe') === '1' || Boolean(req.body?._healthProbe);
  if (isHealthProbe) {
    res.json({ ok: true, status: 'probe_ok' });
    return;
  }

  const editId = Number.parseInt(req.body?.editId, 10);
  const sessionId = Number.parseInt(req.body?.sessionId, 10) || null;
  if (!editId) {
    res.status(400).json({ ok: false, error: 'missing_edit_id' });
    return;
  }

  const result = runRenderDirect(editId);
  res.json({
    ok: true,
    status: 'render_started',
    sessionId,
    editId,
    pid: result.pid,
  });
});

module.exports = router;
