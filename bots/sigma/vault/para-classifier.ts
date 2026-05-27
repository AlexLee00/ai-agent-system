// @ts-nocheck
'use strict';

// Week 3 Day 17-18: PARA 자동 분류기 (Tiago Forte CODE 프레임워크 + LLM)
// Hub LLM 호출 (anthropic_haiku tier) + 규칙 기반 fallback

import path from 'node:path';
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..'
);

export type ParaCategory = 'projects' | 'areas' | 'resources' | 'archives' | 'inbox';

export interface ClassificationResult {
  paraCategory: ParaCategory;
  confidence: number;        // 0.0 ~ 1.0
  reasoning: string;
  classifier: 'rule' | 'llm';
  durationMs: number;
}

const RULE_PATTERNS: Array<{ test: RegExp; category: ParaCategory; weight: number }> = [
  { test: /완료|retired|archive|종료|closed|done|finished/u, category: 'archives', weight: 0.9 },
  { test: /구현|프로젝트|milestone|phase|task|launchd|integration|todo|deadline|sprint/u, category: 'projects', weight: 0.85 },
  { test: /팀|운영|area|luna|blo|ska|darwin|sigma|claude|책임|responsibility|standard/u, category: 'areas', weight: 0.8 },
  { test: /논문|research|자료|reference|pattern|resource|커뮤니티|study|guide|tutorial/u, category: 'resources', weight: 0.8 },
];

function classifyByRule(title: string, content: string): ClassificationResult | null {
  const text = `${title} ${content}`.toLowerCase();
  let best: { category: ParaCategory; weight: number } | null = null;

  for (const pat of RULE_PATTERNS) {
    if (pat.test.test(text) && (!best || pat.weight > best.weight)) {
      best = { category: pat.category, weight: pat.weight };
    }
  }

  if (!best) return null;

  return {
    paraCategory: best.category,
    confidence: best.weight,
    reasoning: `규칙 기반 분류 (패턴 매칭)`,
    classifier: 'rule',
    durationMs: 0,
  };
}

const SYSTEM_PROMPT = `당신은 Tiago Forte의 PARA 시스템 자동 분류기입니다.
주어진 노트를 다음 4가지 카테고리 중 하나로 분류하세요:

- projects: 명확한 목표 + 데드라인이 있는 작업 (예: "서버 마이그레이션", "기능 구현", "버그 수정")
- areas: 지속적 책임 + 표준이 있는 영역 (예: "투자 관리", "팀 운영", "건강 관리")
- resources: 관심사 + 참조 자료 (예: "연구 자료", "튜토리얼", "패턴 모음")
- archives: 비활성 + 완료된 항목 (예: "완료된 프로젝트", "은퇴한 팀", "과거 기록")

반드시 JSON 형태로만 응답하세요:
{"category": "projects|areas|resources|archives", "confidence": 0.0~1.0, "reasoning": "분류 이유"}`;

export async function classifyParaWithLlm(
  title: string,
  content: string,
  options: { timeoutMs?: number } = {},
): Promise<ClassificationResult> {
  const startMs = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000;

  try {
    const hubClient = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-client'));

    const prompt = `제목: ${title}\n\n내용:\n${String(content || '').slice(0, 1000)}`;

    const result = await Promise.race([
      hubClient.callHubLlm({
        callerTeam: 'sigma',
        agent: 'para-classifier',
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        abstractModel: 'anthropic_haiku',
        taskType: 'classification',
        maxTokens: 200,
        temperature: 0.1,
        timeoutMs,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), timeoutMs)),
    ]);

    const text = String(result?.text || '{}').trim();
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');

    const category = parsed.category as ParaCategory;
    const validCategories: ParaCategory[] = ['projects', 'areas', 'resources', 'archives', 'inbox'];
    if (!validCategories.includes(category)) throw new Error(`invalid category: ${category}`);

    return {
      paraCategory: category,
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.7)),
      reasoning: parsed.reasoning || 'LLM 분류',
      classifier: 'llm',
      durationMs: Date.now() - startMs,
    };
  } catch (err: any) {
    // LLM 실패 시 규칙 기반 fallback
    const ruleResult = classifyByRule(title, content);
    if (ruleResult) {
      ruleResult.reasoning = `LLM 실패 후 규칙 기반 fallback (${err?.message || 'unknown error'})`;
      return ruleResult;
    }
    return {
      paraCategory: 'inbox',
      confidence: 0.3,
      reasoning: `분류 실패 — inbox 유지 (${err?.message || 'unknown error'})`,
      classifier: 'rule',
      durationMs: Date.now() - startMs,
    };
  }
}

export async function classify(
  title: string,
  content: string,
  options: { useLlm?: boolean; timeoutMs?: number } = {},
): Promise<ClassificationResult> {
  const useLlm = options.useLlm ?? ['true', '1', 'yes'].includes(String(process.env.SIGMA_VAULT_LLM_CLASSIFICATION || '').toLowerCase());

  // 규칙 기반 먼저 (확신도 0.9 이상이면 LLM 스킵)
  const ruleResult = classifyByRule(title, content);
  if (ruleResult && ruleResult.confidence >= 0.9) return ruleResult;

  if (!useLlm) return ruleResult ?? { paraCategory: 'inbox', confidence: 0.3, reasoning: '규칙 없음', classifier: 'rule', durationMs: 0 };

  return classifyParaWithLlm(title, content, options);
}

export default { classify, classifyParaWithLlm, classifyByRule };
