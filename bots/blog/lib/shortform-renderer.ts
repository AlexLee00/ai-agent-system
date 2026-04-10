'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalizeDurationSec, SHORTFORM_DEFAULT_DURATION_SEC } = require('./shortform-planner');

const execFileAsync = promisify(execFile);

async function renderShortformReel({
  thumbPath,
  outputPath,
  durationSec = SHORTFORM_DEFAULT_DURATION_SEC,
}) {
  if (!thumbPath || !fs.existsSync(thumbPath)) {
    throw new Error(`숏폼 렌더용 썸네일이 없습니다: ${thumbPath}`);
  }

  const safeDurationSec = normalizeDurationSec(durationSec);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const filter = [
    'scale=1080:1920:force_original_aspect_ratio=increase',
    'crop=1080:1920',
    "zoompan=z='min(zoom+0.0008,1.18)':d=250:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    'fps=25'
  ].join(',');

  const args = [
    '-y',
    '-loop', '1',
    '-i', thumbPath,
    '-t', String(safeDurationSec),
    '-vf', filter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ];

  try {
    await execFileAsync('ffmpeg', args, {
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const message = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`ffmpeg 숏폼 렌더 실패: ${message}`);
  }

  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    fileSize: stat.size,
    durationSec: safeDurationSec,
  };
}

module.exports = {
  renderShortformReel,
};
