'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { fork, spawn } = require('child_process');

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { runWithN8nFallback } = require('../../../../packages/core/lib/n8n-runner');
const { buildWebhookCandidates } = require('../../../../packages/core/lib/n8n-webhook-registry');
const { auditLog } = require('../../lib/company-guard');
const { probeDurationMs } = require('../../../video/lib/ffmpeg-preprocess');
const { resolveVideoN8nToken: resolveSharedVideoN8nToken } = require('../../../video/lib/video-n8n-config');
const { loadConfig } = require('../../../video/src/index');
const { storeEditFeedback, estimateWithRAG } = require('../../../video/lib/video-rag');

const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, '../../../..');
const VIDEO_PROJECT_ROOT = path.join(PROJECT_ROOT, 'bots/video');
const VIDEO_TEMP_ROOT = path.join(VIDEO_PROJECT_ROOT, 'temp');
const VIDEO_EXPORTS_ROOT = path.join(VIDEO_PROJECT_ROOT, 'exports');
const VIDEO_RUN_PIPELINE = path.join(PROJECT_ROOT, 'bots/video/scripts/run-pipeline.js');
const VIDEO_RENDER_FROM_EDL = path.join(PROJECT_ROOT, 'bots/video/scripts/render-from-edl.js');
const WORKER_UPLOAD_DIR = path.join(__dirname, '../uploads/video');
const ZIP_TEMP_DIR = path.join(PROJECT_ROOT, 'tmp/video-downloads');
const VIDEO_CONFIG = loadConfig();

fs.mkdirSync(WORKER_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ZIP_TEMP_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4a', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_MIMES = new Set(['video/mp4']);
const AUDIO_MIMES = new Set([
  'audio/mp4',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/wave',
]);
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

function normalizeOriginalFilename(name) {
  const raw = String(name || '');
  if (!raw) return raw;
  if (/[가-힣]/.test(raw)) return raw;

  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (/[가-힣]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // 무시
  }

  return raw;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, WORKER_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(normalizeOriginalFilename(file.originalname) || '').toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (req, file, cb) => {
    const originalName = normalizeOriginalFilename(file.originalname);
    const ext = path.extname(originalName || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const validExt = ALLOWED_EXTENSIONS.has(ext);
    const validMime = VIDEO_MIMES.has(mime) || AUDIO_MIMES.has(mime) || IMAGE_MIMES.has(mime);
    if (!validExt || !validMime) {
      cb(new Error(`허용되지 않은 파일 형식입니다: ${originalName}`));
      return;
    }
    cb(null, true);
  },
});

let ensureVideoSessionsSchemaPromise = null;

function toErrorMessage(error) {
  return error?.message || error?.stderr || error?.stdout || String(error || '알 수 없는 오류');
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompanyId(companyId) {
  return String(companyId || '').trim();
}

async function ensureVideoSessionsSchema() {
  if (ensureVideoSessionsSchemaPromise) return ensureVideoSessionsSchemaPromise;
  ensureVideoSessionsSchemaPromise = (async () => {
    const rows = await pgPool.query(
      'public',
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'video_sessions'
          AND column_name = 'company_id'`
    );
    const dataType = String(rows[0]?.data_type || '').toLowerCase();
    if (dataType && dataType !== 'text') {
      await pgPool.run(
        'public',
        `ALTER TABLE public.video_sessions
            ALTER COLUMN company_id TYPE TEXT
            USING company_id::TEXT`
      );
    }
  })().catch((error) => {
    ensureVideoSessionsSchemaPromise = null;
    throw error;
  });
  return ensureVideoSessionsSchemaPromise;
}

function resolveVideoN8nToken() {
  return resolveSharedVideoN8nToken(VIDEO_CONFIG);
}

function getVideoN8nSettings() {
  const baseUrl = String(VIDEO_CONFIG?.n8n?.base_url || process.env.N8N_BASE_URL || 'http://127.0.0.1:5678').replace(/\/+$/, '');
  const webhookPath = String(VIDEO_CONFIG?.n8n?.webhook_path || 'video-pipeline').replace(/^\/+/, '');
  const workflowName = VIDEO_CONFIG?.n8n?.workflow_name || 'Video Pipeline';
  const healthUrl = VIDEO_CONFIG?.n8n?.health_url || `${baseUrl}/healthz`;
  const token = resolveVideoN8nToken();
  return {
    baseUrl,
    webhookPath,
    workflowName,
    healthUrl,
    token,
  };
}

async function buildVideoWebhookCandidates() {
  const settings = getVideoN8nSettings();
  const defaults = [`${settings.baseUrl}/webhook/${settings.webhookPath}`];
  const candidates = await buildWebhookCandidates({
    workflowName: settings.workflowName,
    method: 'POST',
    pathSuffix: settings.webhookPath,
    defaults,
  });
  return {
    ...settings,
    candidates,
  };
}

function runPipelineDirect({ sessionId, pairIndex, videoPath, audioPath, extraArgs = [] }) {
  const child = fork(VIDEO_RUN_PIPELINE, [
    `--source-video=${videoPath}`,
    `--source-audio=${audioPath}`,
    `--session-id=${sessionId}`,
    `--pair-index=${pairIndex}`,
    ...extraArgs,
    '--skip-render',
  ], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, source: 'direct', pid: child.pid };
}

function runRenderDirect(editId) {
  const child = fork(VIDEO_RENDER_FROM_EDL, [`--edit-id=${editId}`], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, source: 'direct', pid: child.pid };
}

function detectFileType(file) {
  const requestedType = String(file?.requested_file_type || '').trim().toLowerCase();
  if (['video', 'audio', 'intro', 'outro', 'logo'].includes(requestedType)) {
    return requestedType;
  }
  const ext = path.extname(normalizeOriginalFilename(file.originalname) || '').toLowerCase();
  if (ext === '.mp4') return 'video';
  return 'audio';
}

function buildStoredPath(file) {
  return path.resolve(file.path);
}

async function getSessionForCompany(sessionId, companyId) {
  await ensureVideoSessionsSchema();
  const rows = await pgPool.query(
    'public',
    `SELECT *
       FROM video_sessions
      WHERE id = $1
        AND company_id = $2`,
    [sessionId, normalizeCompanyId(companyId)]
  );
  return rows[0] || null;
}

async function getEditForCompany(editId, companyId) {
  await ensureVideoSessionsSchema();
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

async function listFiles(sessionId) {
  return pgPool.query(
    'public',
    `SELECT *
       FROM video_upload_files
      WHERE session_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [sessionId]
  );
}

async function listEdits(sessionId) {
  return pgPool.query(
    'public',
    `SELECT *
       FROM video_edits
      WHERE session_id = $1
      ORDER BY pair_index ASC NULLS LAST, id ASC`,
    [sessionId]
  );
}

async function findEditBySessionPair(sessionId, pairIndex) {
  const rows = await pgPool.query(
    'public',
    `SELECT *
       FROM video_edits
      WHERE session_id = $1
        AND pair_index = $2
      ORDER BY id DESC
      LIMIT 1`,
    [sessionId, pairIndex]
  );
  return rows[0] || null;
}

async function waitForEditCreation(sessionId, pairIndex, options = {}) {
  const attempts = Number(options.attempts || 5);
  const delayMs = Number(options.delayMs || 1000);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const edit = await findEditBySessionPair(sessionId, pairIndex);
    if (edit) return edit;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

async function updateSession(sessionId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const clauses = keys.map((key, index) => `${key} = $${index + 1}`);
  const params = keys.map((key) => fields[key]);
  params.push(sessionId);
  await pgPool.run(
    'public',
    `UPDATE video_sessions
        SET ${clauses.join(', ')},
            updated_at = NOW()
      WHERE id = $${params.length}`,
    params
  );
}

function pairFiles(files) {
  const sorted = [...files].sort((a, b) => {
    if (a.sort_order === b.sort_order) return a.id - b.id;
    return a.sort_order - b.sort_order;
  });
  const byOrder = new Map();
  for (const file of sorted) {
    if (!['video', 'audio'].includes(String(file.file_type || ''))) continue;
    const key = Number(file.sort_order || 0);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(file);
  }

  const pairs = [];
  const pendingVideos = [];
  const pendingAudios = [];

  for (const [, groupedFiles] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    const videos = groupedFiles.filter((file) => file.file_type === 'video');
    const audios = groupedFiles.filter((file) => file.file_type === 'audio');
    const matchCount = Math.min(videos.length, audios.length);

    for (let index = 0; index < matchCount; index += 1) {
      pairs.push({ video: videos[index], audio: audios[index] });
    }

    pendingVideos.push(...videos.slice(matchCount));
    pendingAudios.push(...audios.slice(matchCount));
  }

  const fallbackCount = Math.min(pendingVideos.length, pendingAudios.length);
  for (let index = 0; index < fallbackCount; index += 1) {
    pairs.push({ video: pendingVideos[index], audio: pendingAudios[index] });
  }

  return pairs.map((pair, index) => ({
    ...pair,
    pairIndex: index + 1,
  }));
}

function derivePreviewPath(edit) {
  if (!edit?.trace_id) return null;
  return path.join(VIDEO_TEMP_ROOT, `run-${String(edit.trace_id).slice(0, 8)}`, 'preview.mp4');
}

function deriveVttPath(edit) {
  if (!edit?.trace_id) return null;
  return path.join(VIDEO_TEMP_ROOT, `run-${String(edit.trace_id).slice(0, 8)}`, 'subtitle.vtt');
}

function sendNotFound(res, message = '대상을 찾을 수 없습니다.') {
  return res.status(404).json({ error: message });
}

function sendBadRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function buildSessionDetail(sessionId) {
  const [sessionRows, files, edits] = await Promise.all([
    pgPool.query('public', 'SELECT * FROM video_sessions WHERE id = $1', [sessionId]),
    listFiles(sessionId),
    listEdits(sessionId),
  ]);

  const session = sessionRows[0] || null;
  if (!session) return null;

  return { session, files, edits };
}

function streamWithRange(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    return sendNotFound(res, '파일을 찾을 수 없습니다.');
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
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

router.post('/sessions', auditLog('CREATE', 'video_sessions'), async (req, res) => {
  try {
    await ensureVideoSessionsSchema();
    const title = normalizeTitle(req.body?.title);
    const companyId = normalizeCompanyId(req.user?.company_id);
    if (!companyId) {
      return sendBadRequest(res, '회사 정보가 없어 편집 세션을 만들 수 없습니다.');
    }
    const rows = await pgPool.query(
      'public',
      `INSERT INTO video_sessions (company_id, uploaded_by, title, status)
       VALUES ($1, $2, $3, 'idle')
       RETURNING id, title, status, created_at`,
      [companyId, req.user.id, title || null]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    await ensureVideoSessionsSchema();
    const rows = await pgPool.query(
      'public',
      `SELECT vs.*,
              COALESCE(COUNT(vuf.id), 0) AS uploaded_file_count,
              COALESCE(COUNT(ve.id), 0) AS edit_count
         FROM video_sessions vs
         LEFT JOIN video_upload_files vuf ON vuf.session_id = vs.id
         LEFT JOIN video_edits ve ON ve.session_id = vs.id
        WHERE vs.company_id = $1
        GROUP BY vs.id
        ORDER BY vs.created_at DESC`,
      [normalizeCompanyId(req.user?.company_id)]
    );
    res.json({ sessions: rows });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');
    const detail = await buildSessionDetail(sessionId);
    res.json(detail);
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/sessions/:id/upload', auditLog('UPLOAD', 'video_upload_files'), upload.array('files', 20), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');

    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    if (!uploadedFiles.length) {
      return sendBadRequest(res, '업로드할 파일이 없습니다.');
    }

    const requestedFileType = String(req.body?.file_type || '').trim().toLowerCase();

    const existingFiles = await listFiles(sessionId);
    let sortOrder = existingFiles.length + 1;
    const inserted = [];

    for (const file of uploadedFiles) {
      const originalName = normalizeOriginalFilename(file.originalname);
      const ext = path.extname(originalName || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      file.requested_file_type = requestedFileType;
      const fileType = detectFileType(file);
      const validMime = fileType === 'logo'
        ? IMAGE_MIMES.has(mime)
        : (fileType === 'video' || fileType === 'intro' || fileType === 'outro')
          ? VIDEO_MIMES.has(mime)
          : AUDIO_MIMES.has(mime);
      if (!ALLOWED_EXTENSIONS.has(ext) || !validMime) {
        fs.unlinkSync(file.path);
        return sendBadRequest(res, `허용되지 않은 파일입니다: ${originalName}`);
      }

      const storedPath = buildStoredPath(file);
      let durationMs = null;
      try {
        if (fileType !== 'logo') {
          durationMs = await probeDurationMs(storedPath);
        }
      } catch (_error) {
        durationMs = null;
      }

      const rows = await pgPool.query(
        'public',
        `INSERT INTO video_upload_files (
          session_id,
          file_type,
          original_name,
          stored_name,
          stored_path,
          file_size_mb,
          duration_ms,
          sort_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          sessionId,
          fileType,
          originalName,
          path.basename(storedPath),
          storedPath,
          Number((file.size / 1024 / 1024).toFixed(2)),
          durationMs,
          sortOrder,
        ]
      );
      inserted.push(rows[0]);
      sortOrder += 1;
    }

    const allFiles = await listFiles(sessionId);
    const totalSizeMb = allFiles.reduce((sum, file) => sum + Number(file.file_size_mb || 0), 0);
    await updateSession(sessionId, {
      status: allFiles.length ? 'uploaded' : 'idle',
      file_count: allFiles.length,
      total_size_mb: Number(totalSizeMb.toFixed(2)),
    });

    res.status(201).json({
      uploaded: inserted,
      file_count: allFiles.length,
      total_size_mb: Number(totalSizeMb.toFixed(2)),
    });
  } catch (error) {
    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        if (file?.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.put('/sessions/:id/intro-outro', auditLog('UPDATE', 'video_sessions'), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');

    const intro = req.body?.intro || {};
    const outro = req.body?.outro || {};
    await updateSession(sessionId, {
      intro_mode: String(intro.mode || 'none'),
      intro_prompt: String(intro.prompt || '').trim() || null,
      intro_duration_sec: Number.parseInt(intro.durationSec, 10) || Number(VIDEO_CONFIG?.intro_outro?.default_intro_duration_sec || 3),
      outro_mode: String(outro.mode || 'none'),
      outro_prompt: String(outro.prompt || '').trim() || null,
      outro_duration_sec: Number.parseInt(outro.durationSec, 10) || Number(VIDEO_CONFIG?.intro_outro?.default_outro_duration_sec || 5),
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.put('/sessions/:id/reorder', auditLog('UPDATE', 'video_upload_files'), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');
    const files = Array.isArray(req.body?.files) ? req.body.files : null;
    if (!files || !files.length) return sendBadRequest(res, '정렬 정보가 없습니다.');

    for (const item of files) {
      await pgPool.run(
        'public',
        `UPDATE video_upload_files
            SET sort_order = $1
          WHERE id = $2
            AND session_id = $3`,
        [item.sort_order, item.id, sessionId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.delete('/sessions/:id/files/:fileId', auditLog('DELETE', 'video_upload_files'), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const fileId = Number.parseInt(req.params.fileId, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');

    const rows = await pgPool.query(
      'public',
      `DELETE FROM video_upload_files
       WHERE id = $1
         AND session_id = $2
       RETURNING *`,
      [fileId, sessionId]
    );
    const removed = rows[0];
    if (!removed) return sendNotFound(res, '파일을 찾을 수 없습니다.');
    if (removed.stored_path && fs.existsSync(removed.stored_path)) {
      fs.unlinkSync(removed.stored_path);
    }

    const remaining = await listFiles(sessionId);
    const totalSizeMb = remaining.reduce((sum, file) => sum + Number(file.file_size_mb || 0), 0);
    await updateSession(sessionId, {
      file_count: remaining.length,
      total_size_mb: Number(totalSizeMb.toFixed(2)),
      status: remaining.length ? 'uploaded' : 'idle',
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.put('/sessions/:id/notes', auditLog('UPDATE', 'video_sessions'), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');
    await updateSession(sessionId, {
      edit_notes: String(req.body?.edit_notes || '').trim() || null,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/sessions/:id/start', auditLog('START', 'video_sessions'), async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');

    const files = await listFiles(sessionId);
    const pairs = pairFiles(files);
    if (!pairs.length) {
      return sendBadRequest(res, '편집할 영상-음성 세트를 만들 수 없습니다.');
    }

    const introFile = files.find((file) => file.file_type === 'intro');
    const outroFile = files.find((file) => file.file_type === 'outro');
    const logoFile = files.find((file) => file.file_type === 'logo');

    await updateSession(sessionId, {
      status: 'processing',
      error_message: null,
      file_count: files.length,
    });

    const n8n = await buildVideoWebhookCandidates();
    const n8nHeaders = n8n.token ? { 'X-Video-Token': n8n.token } : {};
    const dispatches = [];

    for (const pair of pairs) {
      await pgPool.run(
        'public',
        `UPDATE video_upload_files
            SET pair_index = $1
          WHERE id IN ($2, $3)`,
        [pair.pairIndex, pair.video.id, pair.audio.id]
      );

      let dispatch = await runWithN8nFallback({
        circuitName: `video:pipeline:${sessionId}:${pair.pairIndex}`,
        webhookCandidates: n8n.candidates,
        healthUrl: n8n.healthUrl,
        headers: n8nHeaders,
        body: {
          sessionId,
          pairIndex: pair.pairIndex,
          sourceVideoPath: pair.video.stored_path,
          sourceAudioPath: pair.audio.stored_path,
          title: session.title || `세트_${pair.pairIndex}`,
          editNotes: session.edit_notes || '',
          skipRender: true,
          introMode: session.intro_mode || 'none',
          introFilePath: introFile?.stored_path || '',
          introPrompt: session.intro_prompt || '',
          introDurationSec: Number(session.intro_duration_sec || VIDEO_CONFIG?.intro_outro?.default_intro_duration_sec || 3),
          introLogoPath: logoFile?.stored_path || '',
          outroMode: session.outro_mode || 'none',
          outroFilePath: outroFile?.stored_path || '',
          outroPrompt: session.outro_prompt || '',
          outroDurationSec: Number(session.outro_duration_sec || VIDEO_CONFIG?.intro_outro?.default_outro_duration_sec || 5),
          outroLogoPath: logoFile?.stored_path || '',
        },
        directRunner: () => runPipelineDirect({
          sessionId,
          pairIndex: pair.pairIndex,
          videoPath: pair.video.stored_path,
          audioPath: pair.audio.stored_path,
          extraArgs: [
            `--title=${session.title || `세트_${pair.pairIndex}`}`,
            `--edit-notes=${session.edit_notes || ''}`,
            `--intro-mode=${session.intro_mode || 'none'}`,
            `--intro-duration=${Number(session.intro_duration_sec || VIDEO_CONFIG?.intro_outro?.default_intro_duration_sec || 3)}`,
            `--outro-mode=${session.outro_mode || 'none'}`,
            `--outro-duration=${Number(session.outro_duration_sec || VIDEO_CONFIG?.intro_outro?.default_outro_duration_sec || 5)}`,
            ...(introFile?.stored_path ? [`--intro-file=${introFile.stored_path}`] : []),
            ...(session.intro_prompt ? [`--intro-prompt=${session.intro_prompt}`] : []),
            ...(logoFile?.stored_path ? [`--intro-logo=${logoFile.stored_path}`] : []),
            ...(outroFile?.stored_path ? [`--outro-file=${outroFile.stored_path}`] : []),
            ...(session.outro_prompt ? [`--outro-prompt=${session.outro_prompt}`] : []),
            ...(logoFile?.stored_path ? [`--outro-logo=${logoFile.stored_path}`] : []),
          ],
        }),
        logger: console,
      });

      let createdEdit = await waitForEditCreation(sessionId, pair.pairIndex);
      if (!createdEdit) {
        console.warn(`[video] 세션 ${sessionId} / pair ${pair.pairIndex}: n8n dispatch 후 video_edits 생성이 확인되지 않아 direct fallback 재시도`);
        dispatch = runPipelineDirect({
          sessionId,
          pairIndex: pair.pairIndex,
          videoPath: pair.video.stored_path,
          audioPath: pair.audio.stored_path,
        });
        createdEdit = await waitForEditCreation(sessionId, pair.pairIndex, { attempts: 8, delayMs: 1000 });
      }

      dispatches.push({
        pairIndex: pair.pairIndex,
        source: dispatch?.source || 'unknown',
        webhookUrl: dispatch?.webhookUrl || null,
        pid: dispatch?.pid || null,
        editId: createdEdit?.id || null,
        verified: Boolean(createdEdit),
      });
    }

    res.json({
      success: true,
      status: 'processing',
      pair_count: pairs.length,
      dispatches,
    });
  } catch (error) {
    await updateSession(Number.parseInt(req.params.id, 10), {
      status: 'failed',
      error_message: toErrorMessage(error),
    }).catch(() => {});
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/sessions/:id/status', async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');
    const edits = await listEdits(sessionId);

    let computedStatus = session.status;
    if (edits.length && edits.every((edit) => edit.status === 'completed')) {
      computedStatus = 'done';
      if (session.status !== 'done') {
        await updateSession(sessionId, { status: 'done' });
      }
    } else if (edits.some((edit) => edit.status === 'failed')) {
      computedStatus = 'failed';
    } else if (edits.some((edit) => edit.status === 'preview_ready')) {
      computedStatus = 'preview_ready';
    } else if (edits.length) {
      computedStatus = 'processing';
    }

    res.json({
      session: { ...session, status: computedStatus },
      edits: edits.map((edit) => ({
        ...edit,
        preview_available: Boolean(derivePreviewPath(edit) && fs.existsSync(derivePreviewPath(edit))),
        subtitle_available: Boolean(deriveVttPath(edit) && fs.existsSync(deriveVttPath(edit))),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/estimate', async (req, res) => {
  try {
    const durationMin = Number.parseFloat(req.query.total_duration_min || '0');
    const sizeMb = Number.parseFloat(req.query.total_size_mb || '0');
    const videoCount = Number.parseInt(req.query.video_count || '0', 10) || 0;

    const ragEstimate = await estimateWithRAG(videoCount, sizeMb, durationMin);
    if (Number(ragEstimate.estimated_ms || 0) > 0) {
      return res.json(ragEstimate);
    }

    const minDurationMs = Math.max(0, durationMin * 60 * 1000 * 0.8);
    const maxDurationMs = durationMin > 0 ? durationMin * 60 * 1000 * 1.2 : Number.MAX_SAFE_INTEGER;
    const minSizeMb = Math.max(0, sizeMb * 0.7);
    const maxSizeMb = sizeMb > 0 ? sizeMb * 1.3 : Number.MAX_SAFE_INTEGER;

    const rows = await pgPool.query(
      'public',
      `SELECT AVG(total_ms)::BIGINT AS estimated_ms,
              COUNT(*)::INTEGER AS sample_count
         FROM video_edits
        WHERE total_ms IS NOT NULL
          AND raw_duration_ms BETWEEN $1 AND $2
          AND COALESCE(output_size_mb, 0) BETWEEN $3 AND $4`,
      [minDurationMs, maxDurationMs, minSizeMb, maxSizeMb]
    );

    const sampleCount = Number(rows[0]?.sample_count || 0);
    const estimatedMs = Number(rows[0]?.estimated_ms || 0);
    const confidence = sampleCount >= 5 ? 'high' : sampleCount >= 2 ? 'medium' : 'low';

    return res.json({
      estimated_ms: estimatedMs,
      confidence,
      sample_count: sampleCount,
      estimated_cost_usd: 0,
      samples: [],
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/edits/:id/confirm', auditLog('CONFIRM', 'video_edits'), async (req, res) => {
  try {
    const editId = Number.parseInt(req.params.id, 10);
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');

    await pgPool.run(
      'public',
      `UPDATE video_edits
          SET confirm_status = 'confirmed',
              reject_reason = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [editId]
    );
    storeEditFeedback(editId, { confirmed: true, text: '' }, VIDEO_CONFIG).catch(() => {});

    const edits = await listEdits(edit.session_id);
    const allConfirmed = edits.length && edits.every((row) => (
      row.id === editId ? true : row.confirm_status === 'confirmed'
    ));
    if (allConfirmed) {
      await updateSession(edit.session_id, { status: 'rendering' });
      const n8n = await buildVideoWebhookCandidates();
      const n8nHeaders = n8n.token ? { 'X-Video-Token': n8n.token } : {};
      const dispatches = [];
      for (const targetEdit of edits.map((row) => row.id === editId ? { ...row, confirm_status: 'confirmed' } : row)) {
        if (targetEdit.status === 'completed') continue;
        const dispatch = await runWithN8nFallback({
          circuitName: `video:render:${targetEdit.id}`,
          webhookCandidates: n8n.candidates,
          healthUrl: n8n.healthUrl,
          headers: n8nHeaders,
          body: {
            sessionId: edit.session_id,
            editId: targetEdit.id,
            skipRender: false,
          },
          directRunner: () => runRenderDirect(targetEdit.id),
          logger: console,
        });
        dispatches.push({
          editId: targetEdit.id,
          source: dispatch?.source || 'unknown',
          webhookUrl: dispatch?.webhookUrl || null,
          pid: dispatch?.pid || null,
        });
      }
      return res.json({ success: true, status: 'rendering', dispatches });
    } else {
      await updateSession(edit.session_id, { status: 'confirming' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.post('/edits/:id/reject', auditLog('REJECT', 'video_edits'), async (req, res) => {
  try {
    const editId = Number.parseInt(req.params.id, 10);
    const reason = String(req.body?.reason || '').trim();
    const edit = await getEditForCompany(editId, req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    if (!reason) return sendBadRequest(res, '재편집 사유를 입력해주세요.');

    await pgPool.run(
      'public',
      `UPDATE video_edits
          SET confirm_status = 'rejected',
              reject_reason = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [editId, reason]
    );
    storeEditFeedback(editId, {
      confirmed: false,
      rejectReason: reason,
      text: reason,
    }, VIDEO_CONFIG).catch(() => {});
    await updateSession(edit.session_id, {
      status: 'confirming',
      error_message: `재편집 요청: ${reason}`,
    });

    res.json({
      success: true,
      phase2: true,
      message: '재편집 트리거는 Phase 2에서 연결됩니다.',
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/edits/:id/preview', async (req, res) => {
  try {
    const edit = await getEditForCompany(Number.parseInt(req.params.id, 10), req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    const previewPath = derivePreviewPath(edit);
    if (!previewPath) return sendNotFound(res, '프리뷰 경로를 찾을 수 없습니다.');
    return streamWithRange(req, res, previewPath, 'video/mp4');
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/edits/:id/subtitle', async (req, res) => {
  try {
    const edit = await getEditForCompany(Number.parseInt(req.params.id, 10), req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    const subtitlePath = deriveVttPath(edit);
    if (!subtitlePath || !fs.existsSync(subtitlePath)) {
      return sendNotFound(res, '자막 파일을 찾을 수 없습니다.');
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    fs.createReadStream(subtitlePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/edits/:id/download', async (req, res) => {
  try {
    const edit = await getEditForCompany(Number.parseInt(req.params.id, 10), req.user.company_id);
    if (!edit) return sendNotFound(res, '편집 세트를 찾을 수 없습니다.');
    if (!edit.output_path || !fs.existsSync(edit.output_path)) {
      return sendNotFound(res, '최종 렌더 파일이 없습니다.');
    }
    return res.download(edit.output_path, path.basename(edit.output_path));
  } catch (error) {
    return res.status(500).json({ error: toErrorMessage(error) });
  }
});

router.get('/sessions/:id/download-all', async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const session = await getSessionForCompany(sessionId, req.user.company_id);
    if (!session) return sendNotFound(res, '세션을 찾을 수 없습니다.');
    const edits = await listEdits(sessionId);
    const files = edits
      .filter((edit) => edit.confirm_status === 'confirmed' && edit.output_path && fs.existsSync(edit.output_path))
      .map((edit) => edit.output_path);
    if (!files.length) {
      return sendBadRequest(res, '다운로드 가능한 확정 파일이 없습니다.');
    }

    const archivePath = path.join(ZIP_TEMP_DIR, `video-session-${sessionId}-${Date.now()}.zip`);
    const zipArgs = ['-j', archivePath, ...files];
    await new Promise((resolve, reject) => {
      const proc = spawn('zip', zipArgs, { cwd: PROJECT_ROOT });
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `zip 종료 코드 ${code}`));
      });
    });

    res.download(archivePath, `video-session-${sessionId}.zip`, (error) => {
      if (fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      if (error && !res.headersSent) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

module.exports = router;
