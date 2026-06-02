#!/usr/bin/env node
// @ts-nocheck
/**
 * Phase 1: 가드 분류 감사 스크립트
 *
 * 8개 핵심 파일을 스캔하여 모든 가드 패턴을 A/B/C로 분류한다.
 *   A. 안전 가드 (보존): 자금/시스템/PROTECTED 보호
 *   B. 데이터 수집 가드 (보존): 매매 못해도 데이터 수집
 *   C. 거래 막기 가드 (변환 대상): 매매를 막아 데이터 수집 차단
 *
 * 결과: docs/strategy/LUNA_GUARD_INVENTORY_2026-05-27.md
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const PROJECT_ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const SHARED = resolve(PROJECT_ROOT, 'bots/investment/shared');

const TARGET_FILES = [
  'position-reevaluator.ts',
  'technical-change-gates.ts',
  'trade-data-derived-guards.ts',
  'entry-trigger-engine.ts',
  'trade-quality-evaluator.ts',
  'risk-approval-execution-guard.ts',
  'luna-fallback-policy.ts',
  'capital-manager.ts',
];

// 막기 패턴 (이 패턴이 있으면 거래 차단 가드)
const BLOCK_PATTERNS = [
  { pattern: /blocked:\s*true/g,      label: 'blocked:true' },
  { pattern: /approved:\s*false/g,    label: 'approved:false' },
  { pattern: /action:\s*['"]HOLD['"]/g, label: "action:'HOLD' (forced)" },
  { pattern: /return\s*\{\s*ok:\s*false/g, label: 'return {ok:false}' },
  { pattern: /amount_usdt:\s*0/g,     label: 'amount_usdt:0 (block)' },
  { pattern: /status:\s*['"]blocked['"]/g, label: "status:'blocked'" },
];

// 안전 가드 키워드 (분류 A): 실제 자금/포지션/운영 안전을 보호하므로 보존한다.
const SAFETY_KEYWORDS = [
  'capital',
  'hard_limit',
  'HARD limit',
  'HARD block',
  'PROTECTED',
  'structural_hard_block',
  'crypto_structural_symbol_block',
  'stop_loss_threshold',
  'tp_sl_required_not_met',
  'dynamic_trail_stop_breached',
  'nemesis',
  'open_position_reentry_guard',
  'duplicate_fire_cooldown',
  'predictive_observation_cycle_cap',
  'llm_emergency_stop',
  'persist_failed',
  'circuit',
  'correlation_guard',
  'mode_blocked',
  'mode_observe_only',
  'api.*fail',
  'fund.*limit',
  'max.*capital',
];

// 데이터 수집/notify 가드 키워드 (분류 B): 알림/기록/관찰 경로로 전환되어 데이터 루프를 유지한다.
const DATA_COLLECTION_KEYWORDS = [
  'reflexion',
  'quality_eval',
  'learning',
  'evaluation',
  'feedback',
  'dryRun',
  'dry_run',
  'budget',
  'recordGuardEvent',
  'notifyMode',
  'notify mode',
  'LUNA_FULL_DATA_LOOP',
  'fullDataLoopEnabled',
  'observed',
  'observedOnly',
  'entry_trigger_armed',
  'triggerState',
  'tradingview_chart',
  'low_confidence',
  'mature_position_hold',
  'constitution_blocked',
  'trigger_type_disabled',
  'pullback_confirmation_incomplete',
  'fire_condition_unmet',
  'promotion_shadow_readiness_incomplete',
  'execution_freshness_guard',
];

// paper 강제 패턴
const PAPER_FORCE_PATTERNS = [
  { pattern: /paper:\s*true/g,               label: 'paper:true' },
  { pattern: /trade_mode:\s*['"]paper['"]/g, label: "trade_mode:'paper'" },
  { pattern: /paper_mode:\s*true/g,          label: 'paper_mode:true' },
];

function classifyLine(line, lineNum, context = '') {
  const searchable = `${context}\n${line}`;
  const hasSafetyKeyword = SAFETY_KEYWORDS.some((kw) => new RegExp(kw, 'i').test(searchable));
  const hasDataKeyword = DATA_COLLECTION_KEYWORDS.some((kw) => new RegExp(kw, 'i').test(searchable));

  for (const { pattern, label } of BLOCK_PATTERNS) {
    const clone = new RegExp(pattern.source, pattern.flags);
    if (clone.test(line)) {
      const category = hasSafetyKeyword ? 'A' : hasDataKeyword ? 'B' : 'C';
      return { lineNum, type: 'block', label, category, line: line.trim().slice(0, 120) };
    }
  }
  for (const { pattern, label } of PAPER_FORCE_PATTERNS) {
    const clone = new RegExp(pattern.source, pattern.flags);
    if (clone.test(line)) {
      return { lineNum, type: 'paper_force', label, category: 'paper', line: line.trim().slice(0, 120) };
    }
  }
  return null;
}

function scanFile(filename) {
  const filepath = resolve(SHARED, filename);
  let content;
  try {
    content = readFileSync(filepath, 'utf-8');
  } catch {
    return { filename, error: 'File not found', results: [] };
  }
  const lines = content.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const context = lines.slice(Math.max(0, i - 8), Math.min(lines.length, i + 9)).join('\n');
    const match = classifyLine(lines[i], i + 1, context);
    if (match) results.push(match);
  }
  return { filename, lines: lines.length, results };
}

function buildReport(scans) {
  const now = new Date().toISOString().split('T')[0];
  const totalBlocks = scans.flatMap((s) => s.results).filter((r) => r.type === 'block').length;
  const totalPaper = scans.flatMap((s) => s.results).filter((r) => r.type === 'paper_force').length;
  const catA = scans.flatMap((s) => s.results).filter((r) => r.category === 'A').length;
  const catB = scans.flatMap((s) => s.results).filter((r) => r.category === 'B').length;
  const catC = scans.flatMap((s) => s.results).filter((r) => r.category === 'C').length;

  let md = `# LUNA 가드 인벤토리 — ${now}\n\n`;
  md += `> 자동 생성: guard-classification-audit.ts\n\n`;
  md += `## 요약\n\n`;
  md += `| 항목 | 수 |\n|------|----|\n`;
  md += `| 막기 가드 (전체) | ${totalBlocks} |\n`;
  md += `| paper 강제 | ${totalPaper} |\n`;
  md += `| A. 안전 가드 (보존) | ${catA} |\n`;
  md += `| B. 데이터 수집 가드 (보존) | ${catB} |\n`;
  md += `| C. 거래 막기 → 변환 대상 | ${catC} |\n\n`;

  for (const scan of scans) {
    if (scan.error) {
      md += `## ${scan.filename}\n\n> ⚠️ ${scan.error}\n\n`;
      continue;
    }
    const blocks = scan.results.filter((r) => r.type === 'block');
    const papers = scan.results.filter((r) => r.type === 'paper_force');
    md += `## ${scan.filename} (${scan.lines}줄)\n\n`;
    md += `막기: **${blocks.length}**곳 | paper 강제: **${papers.length}**곳\n\n`;
    if (blocks.length > 0) {
      md += `### 막기 가드\n\n`;
      md += `| 라인 | 분류 | 패턴 | 코드 |\n|------|------|------|------|\n`;
      for (const r of blocks) {
        const cls = r.category === 'A' ? '✅ A 안전' : r.category === 'B' ? '🔵 B 수집' : '🚨 C 변환';
        md += `| ${r.lineNum} | ${cls} | \`${r.label}\` | \`${r.line.replace(/`/g, "'")}\` |\n`;
      }
      md += '\n';
    }
    if (papers.length > 0) {
      md += `### paper 강제 (마스터 의도 확인 필요)\n\n`;
      md += `| 라인 | 패턴 | 코드 |\n|------|------|------|\n`;
      for (const r of papers) {
        md += `| ${r.lineNum} | \`${r.label}\` | \`${r.line.replace(/`/g, "'")}\` |\n`;
      }
      md += '\n';
    }
  }

  md += `## 변환 권장 순서 (C 분류 많은 순)\n\n`;
  const sortedByC = [...scans]
    .map((s) => ({ filename: s.filename, c: s.results.filter((r) => r.category === 'C').length }))
    .filter((item) => item.c > 0)
    .sort((a, b) => b.c - a.c);
  for (const item of sortedByC) {
    md += `- \`${item.filename}\`: **${item.c}**곳 C 분류\n`;
  }
  md += '\n';
  md += `## 다음 단계\n\n`;
  md += `1. 이 문서를 마스터가 검토하여 A/B/C 분류 승인\n`;
  md += `2. paper 강제 17곳 의도 확인 후 결정\n`;
  md += `3. C 분류 순서대로 Block→Notify 변환 진행\n`;
  return md;
}

async function main() {
  console.log('[GuardAudit] 가드 분류 스캔 시작...');
  const scans = TARGET_FILES.map(scanFile);
  const report = buildReport(scans);

  const outPath = resolve(PROJECT_ROOT, 'docs/strategy/LUNA_GUARD_INVENTORY_2026-05-27.md');
  mkdirSync(resolve(PROJECT_ROOT, 'docs/strategy'), { recursive: true });
  writeFileSync(outPath, report, 'utf-8');

  const total = scans.flatMap((s) => s.results).length;
  const catC = scans.flatMap((s) => s.results).filter((r) => r.category === 'C').length;
  console.log(`[GuardAudit] 완료: 총 ${total}개 가드 발견, C 분류 ${catC}개`);
  console.log(`[GuardAudit] 보고서: ${outPath}`);
}

main().catch((err) => {
  console.error('[GuardAudit] 오류:', err?.message);
  process.exit(1);
});
