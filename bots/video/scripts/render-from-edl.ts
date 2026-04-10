// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { applyMediaBinaryEnv } = require('../lib/media-binary-env');

applyMediaBinaryEnv(process.env);

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { loadConfig } = require('../src/index');
const { loadEDL, renderFinal } = require('../lib/edl-builder');
const { probeDurationMs } = require('../lib/ffmpeg-preprocess');

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const PROJECT_ROOT = path.join(__dirname, '..');
const TEMP_ROOT = path.join(PROJECT_ROOT, 'temp');
const EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports');

function parseArgs(argv) {
  const parsed = { editId: null };
  for (const arg of argv) {
    if (arg.startsWith('--edit-id=')) {
      parsed.editId = Number.parseInt(arg.slice('--edit-id='.length), 10) || null;
    }
  }
  return parsed;
}

function sanitizeTitle(title) {
  return String(title || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function toErrorMessage(error) {
  return error?.message || error?.stderr || error?.stdout || String(error || '알 수 없는 오류');
}

async function updateVideoEdit(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const clauses = keys.map((key, index) => `${key} = $${index + 1}`);
  const params = keys.map((key) => fields[key]);
  params.push(id);
  await pgPool.run(
    'public',
    `UPDATE video_edits
        SET ${clauses.join(', ')},
            updated_at = NOW()
      WHERE id = $${params.length}`,
    params
  );
}

async function updateSessionStatus(sessionId) {
  if (!sessionId) return;
  const edits = await pgPool.query(
    'public',
    `SELECT status, whisper_cost, correction_cost
       FROM video_edits
      WHERE session_id = $1`,
    [sessionId]
  );
  if (!edits.length) return;

  if (edits.every((edit) => edit.status === 'completed')) {
    const totalCost = edits.reduce(
      (sum, edit) => sum + Number(edit.whisper_cost || 0) + Number(edit.correction_cost || 0),
      0
    );
    await pgPool.run(
      'public',
      `UPDATE video_sessions
          SET status = 'done',
              total_cost = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [sessionId, Number(totalCost.toFixed(4))]
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.editId) {
    throw new Error('--edit-id는 필수입니다.');
  }

  const rows = await pgPool.query(
    'public',
    `SELECT *
       FROM video_edits
      WHERE id = $1`,
    [args.editId]
  );
  const edit = rows[0];
  if (!edit) {
    throw new Error(`video_edits(${args.editId})를 찾을 수 없습니다.`);
  }

  const traceId = String(edit.trace_id || '');
  if (!traceId) {
    throw new Error('trace_id가 없어 렌더 세션 경로를 찾을 수 없습니다.');
  }

  const config = loadConfig();
  const sessionDir = path.join(TEMP_ROOT, `run-${traceId.slice(0, 8)}`);
  const edlPath = path.join(sessionDir, 'edit_decision_list.json');
  if (!fs.existsSync(edlPath)) {
    throw new Error(`EDL 파일을 찾을 수 없습니다: ${edlPath}`);
  }

  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const title = sanitizeTitle(edit.title || `video-${edit.id}`);
  const exportPath = path.join(EXPORTS_DIR, `편집_${title}.mp4`);
  const edl = loadEDL(edlPath);

  await updateVideoEdit(edit.id, { status: 'rendering' });

  const startedAt = Date.now();
  try {
    const result = await renderFinal(edl, exportPath, config);
    const renderMs = Date.now() - startedAt;
    const outputSizeMb = Number((result.fileSize / 1024 / 1024).toFixed(2));
    const outputDurationMs = await probeDurationMs(result.outputPath);

    await updateVideoEdit(edit.id, {
      output_path: result.outputPath,
      output_size_mb: outputSizeMb,
      output_duration_ms: outputDurationMs,
      render_ms: renderMs,
      total_ms: Number(edit.total_ms || 0) + renderMs,
      status: 'completed',
    });
    await updateSessionStatus(edit.session_id);
    await postAlarm({
      message: [
        '[비디오] 최종 렌더 완료',
        `세트 ID: ${edit.id}`,
        `제목: ${edit.title || edit.id}`,
        `파일: ${result.outputPath}`,
      ].join('\n'),
      team: TEAM_NAME,
      alertLevel: 2,
      fromBot: 'render-from-edl',
    });
  } catch (error) {
    await updateVideoEdit(edit.id, {
      status: 'failed',
      error_message: toErrorMessage(error),
    });
    await pgPool.run(
      'public',
      `UPDATE video_sessions
          SET status = 'failed',
              error_message = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [edit.session_id, toErrorMessage(error)]
    );
    await postAlarm({
      message: [
        '[비디오] 최종 렌더 실패',
        `세트 ID: ${edit.id}`,
        `제목: ${edit.title || edit.id}`,
        `사유: ${toErrorMessage(error)}`,
      ].join('\n'),
      team: TEAM_NAME,
      alertLevel: 2,
      fromBot: 'render-from-edl',
    });
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${BOT_NAME}] render-from-edl 실패: ${toErrorMessage(error)}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  main,
};
