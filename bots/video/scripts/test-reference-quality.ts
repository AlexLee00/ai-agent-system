// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { compareVideos } = require('../lib/reference-quality');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');

const SAMPLE_MAP = {
  db생성: {
    reference: path.join(SAMPLES_DIR, 'edited', '편집_DB생성.mp4'),
  },
  동적데이터: {
    reference: path.join(SAMPLES_DIR, 'edited', '편집_동적데이터.mp4'),
  },
  서버인증: {
    reference: path.join(SAMPLES_DIR, 'edited', '편집_서버인증.mp4'),
  },
  컴포넌트스테이트: {
    reference: path.join(SAMPLES_DIR, 'edited', '편집_컴포넌트스테이트.mp4'),
  },
  파라미터: {
    reference: path.join(SAMPLES_DIR, 'edited', '편집_파라미터.mp4'),
  },
};

function parseArgs(argv) {
  const parsed = {
    generated: null,
    reference: null,
    sample: null,
    json: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--generated=')) parsed.generated = arg.slice('--generated='.length);
    if (arg.startsWith('--reference=')) parsed.reference = arg.slice('--reference='.length);
    if (arg.startsWith('--sample=')) parsed.sample = arg.slice('--sample='.length);
    if (arg === '--json') parsed.json = true;
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveReferencePath(args) {
  if (args.reference) return path.resolve(args.reference);
  if (!args.sample) return null;
  const key = String(args.sample || '').trim();
  const sample = SAMPLE_MAP[key];
  return sample ? sample.reference : null;
}

function printHumanReport(sampleName, result) {
  console.log(`[reference-quality] sample=${sampleName || 'custom'}`);
  console.log(`[reference-quality] generated=${result.generated.path}`);
  console.log(`[reference-quality] reference=${result.reference.path}`);
  console.log(`[reference-quality] overall=${result.scores.overall}`);
  console.log(`[reference-quality] duration=${result.scores.duration} visual=${result.scores.visual_similarity} resolution=${result.scores.resolution} fps=${result.scores.fps} audio=${result.scores.audio_spec}`);
  console.log(`[reference-quality] delta duration=${result.deltas.durationSec}s width=${result.deltas.width} height=${result.deltas.height} fps=${result.deltas.fps}`);
  console.log('[reference-quality] visual samples:', result.visualSamples.map((item) => `${item.second}s=${item.similarity}`).join(', '));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert(args.generated, '--generated는 필수입니다.');
  const generatedPath = path.resolve(args.generated);
  const referencePath = resolveReferencePath(args);
  assert(referencePath, '--reference 또는 --sample이 필요합니다.');
  assert(fs.existsSync(generatedPath), `generated 파일이 없습니다: ${generatedPath}`);
  assert(fs.existsSync(referencePath), `reference 파일이 없습니다: ${referencePath}`);

  const result = await compareVideos(generatedPath, referencePath);

  if (args.json) {
    console.log(JSON.stringify({
      sample: args.sample || null,
      ...result,
    }, null, 2));
    return;
  }

  printHumanReport(args.sample, result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[reference-quality] 실패:', error.message);
    process.exit(1);
  });
}

module.exports = {
  SAMPLE_MAP,
  parseArgs,
  resolveReferencePath,
  main,
};
