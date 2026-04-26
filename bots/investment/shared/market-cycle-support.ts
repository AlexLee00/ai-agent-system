// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const BANNER_WIDTH = 60;

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || join(homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || join(getAiAgentHome(), 'workspace');
}

export function getInvestmentStateDir() {
  return process.env.INVESTMENT_STATE_DIR || join(getAiAgentHome(), 'investment');
}

export function getInvestmentRuntimeDir() {
  return process.env.INVESTMENT_RUNTIME_DIR || join(getAiAgentWorkspace(), 'investment');
}

export function getInvestmentStateFile(filename) {
  return join(getInvestmentStateDir(), filename);
}

export function getInvestmentRuntimeFile(filename) {
  return join(getInvestmentRuntimeDir(), filename);
}

export function investmentRuntimeFileExists(filename) {
  return existsSync(getInvestmentRuntimeFile(filename));
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
    mkdirSync(dirname(stateFile), { recursive: true });
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
