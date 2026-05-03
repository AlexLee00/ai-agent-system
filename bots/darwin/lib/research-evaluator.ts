'use strict';

/**
 * 다윈 논문 평가기 — 한국어 요약 + 적합성 점수
 */

interface HubLlmResponse {
  text?: string;
}

interface PaperCandidate {
  title: string;
  summary: string;
  domain?: string;
  source?: string;
  arxiv_id?: string;
}

interface EvaluationResult {
  korean_summary: string;
  relevance_score: number;
  reason: string;
  evaluation_failed?: boolean;
  failure_code?: string;
}

const { callHubLlm }: {
  callHubLlm: (request: Record<string, unknown>) => Promise<HubLlmResponse>;
} = require('../../../packages/core/lib/hub-client');

const SYSTEM_PROMPT = `당신은 팀 제이의 연구 분석가입니다.
팀 제이는 113개 AI 에이전트를 운영하는 멀티에이전트 자동화 플랫폼입니다.
10개 팀: 루나(자동매매), 블로(블로그), 클로드(모니터링), 스카(스터디카페),
워커(SaaS), 비디오(영상), 다윈(연구), 저스틴(감정), 시그마(데이터), 제이(오케스트레이터).

논문을 읽고 두 가지를 응답하세요:
1. 요약: 한국어 1~2줄 핵심 요약
2. 적합성: 우리 시스템에 적용 가능성 0~10점
   (0=무관, 5=참고할만함, 7+=직접 적용 가능, 10=즉시 적용)
   7점 이상은 우리 코드에 직접 적용 가능한 경우만 주세요.
   단순히 관련 분야라는 이유만으로 7점 이상을 주지 마세요.
   평균 적합성은 4~5점이 정상입니다.

반드시 아래 형식으로만 응답:
요약: (한국어 1~2줄)
적합성: (숫자)
이유: (한국어 1줄)`;

function parseEvaluationText(text: string): EvaluationResult | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const summaryMatch =
    normalized.match(/요약\s*[:：]\s*([^\n]+)/)
    || normalized.match(/summary\s*[:：]\s*([^\n]+)/i);
  const scoreMatch =
    normalized.match(/적합성\s*[:：]\s*(\d+(?:\.\d+)?)/)
    || normalized.match(/relevance\s*[:：]\s*(\d+(?:\.\d+)?)/i)
    || normalized.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/);
  const reasonMatch =
    normalized.match(/이유\s*[:：]\s*([^\n]+)/)
    || normalized.match(/reason\s*[:：]\s*([^\n]+)/i);

  const summary = String(summaryMatch?.[1] || '').trim();
  const rawScore = Number.parseFloat(String(scoreMatch?.[1] || ''));
  if (!summary || !Number.isFinite(rawScore)) return null;

  return {
    korean_summary: summary,
    relevance_score: Math.max(0, Math.min(10, Math.round(rawScore))),
    reason: String(reasonMatch?.[1] || '').trim(),
  };
}

async function evaluatePaper(paper: PaperCandidate): Promise<EvaluationResult> {
  try {
    const request = {
      callerTeam: 'darwin',
      agent: 'research',
      taskType: 'paper_evaluation',
      abstractModel: 'anthropic_haiku',
      systemPrompt: SYSTEM_PROMPT,
      prompt: `제목: ${paper.title}\n초록: ${paper.summary}`,
      timeoutMs: 15_000,
    };

    let result = await callHubLlm(request);
    let parsed = parseEvaluationText(String(result?.text || ''));

    if (!parsed) {
      result = await callHubLlm({
        ...request,
        taskType: 'paper_evaluation_retry',
        prompt: `${request.prompt}\n\n형식 재강조:\n요약: 한 줄\n적합성: 숫자 하나\n이유: 한 줄`,
      });
      parsed = parseEvaluationText(String(result?.text || ''));
    }

    if (!parsed) {
      throw new Error('paper_evaluation_parse_failed');
    }

    return parsed;
  } catch (err) {
    const errorMessage =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message || 'unknown error')
        : String(err || 'unknown error');
    console.warn(`[research-evaluator] 평가 실패 (${paper.arxiv_id || paper.title}): ${errorMessage}`);
    return {
      korean_summary: paper.title,
      relevance_score: 0,
      reason: '평가 실패',
      evaluation_failed: true,
      failure_code: errorMessage || 'paper_evaluation_failed',
    };
  }
}

module.exports = {
  evaluatePaper,
  SYSTEM_PROMPT,
};
