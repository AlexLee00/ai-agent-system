#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { mirrorExistingPosttradeSkills } from '../shared/posttrade-skill-extractor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-posttrade-skills-'));
  process.env.LUNA_POSTTRADE_SKILL_FILE_MIRROR_ROOT = root;
  const agentName = `mirror-smoke-agent-${Date.now()}`;
  const patternKey = `crypto:mirror_smoke:bull:long:${Date.now()}`;
  try {
    const upserted = await db.upsertPosttradeSkill({
      market: 'crypto',
      agentName,
      skillType: 'success',
      patternKey,
      title: `SUCCESS ${patternKey}`,
      summary: 'mirror smoke skill',
      invocationCount: 3,
      successRate: 0.9,
      winCount: 3,
      lossCount: 0,
      sourceTradeIds: [1, 2, 3],
      metadata: { smoke: true },
    });
    assert.ok(upserted?.id, 'skill upserted');

    const mirrored = await mirrorExistingPosttradeSkills({ agentName, market: 'crypto', limit: 5 });
    const target = mirrored.mirroredFiles.find((file) => String(file).includes('mirror_smoke'));
    assert.ok(target, 'mirror file returned');
    assert.equal(fs.existsSync(target), true, 'mirror file exists');
    const content = fs.readFileSync(target, 'utf8');
    assert.match(content, /mirror smoke skill/, 'mirror content includes summary');

    return {
      ok: true,
      root,
      mirroredCount: mirrored.mirroredFiles.length,
      target,
    };
  } finally {
    await db.run(
      `DELETE FROM investment.luna_posttrade_skills
        WHERE agent_name = $1 AND pattern_key = $2`,
      [agentName, patternKey],
    ).catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-skill-file-mirror-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-skill-file-mirror-smoke 실패:',
  });
}
