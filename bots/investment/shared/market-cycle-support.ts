// @ts-nocheck
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BANNER_WIDTH = 60;

export function getOpenClawStateFile(filename) {
  return join(homedir(), '.openclaw', filename);
}

export function loadJsonState(stateFile, fallbackState = {}) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { ...fallbackState };
  }
}

export function saveJsonState(stateFile, state) {
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn(`  ⚠️ 상태 저장 실패: ${error.message}`);
  }
}

export function shouldRunFixedIntervalCycle({
  force = false,
  lastCycleAt = 0,
  intervalMs,
  now = Date.now(),
  toKst,
}) {
  if (force) return { run: true, reason: '--force 옵션' };
  if (now - lastCycleAt >= intervalMs) {
    return { run: true, reason: `${Math.round(intervalMs / 60000)}분 정규 사이클` };
  }
  const remainMin = Math.ceil((intervalMs - (now - lastCycleAt)) / 60000);
  const lastTime = lastCycleAt > 0
    ? toKst(new Date(lastCycleAt))
    : '없음';
  console.log(`⏳ 다음 사이클까지 ${remainMin}분 (마지막: ${lastTime})`);
  return { run: false, reason: `대기 중 (${remainMin}분 남음)` };
}

function printBanner(lines = []) {
  console.log(`\n${'═'.repeat(BANNER_WIDTH)}`);
  for (const line of lines) console.log(line);
  console.log(`${'═'.repeat(BANNER_WIDTH)}`);
}

export function logMarketCycleStart({ icon, tag, marketLabel, now, symbols = [], extraLines = [] }) {
  printBanner([
    `${icon} ${tag} ${marketLabel} 사이클 시작 — ${now}`,
    `   심볼: ${symbols.join(', ')}`,
    ...extraLines,
  ]);
}

export function logMarketCycleComplete({ tag, marketLabel, elapsedSec, signalCount, dailyCost }) {
  printBanner([
    `✅ ${tag} ${marketLabel} 사이클 완료 — ${elapsedSec}초 | ${signalCount}개 신호 | LLM $${dailyCost.toFixed(4)}/일`,
  ]);
  console.log('');
}

export function logResearchCycleStart({ marketLabel, now, symbols = [] }) {
  printBanner([
    `📚 [RESEARCH] ${marketLabel} 장외 분석 시작 — ${now}`,
    `   심볼: ${symbols.join(', ')}`,
  ]);
}

export function logResearchCycleComplete({ marketLabel, elapsedSec }) {
  console.log(`\n✅ [RESEARCH] ${marketLabel} 장외 분석 완료 — ${elapsedSec}초`);
}
