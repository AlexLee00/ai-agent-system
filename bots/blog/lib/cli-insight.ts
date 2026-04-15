// @ts-nocheck
import { generateGemmaPilotText } from '../../../packages/core/lib/gemma-pilot.ts';

function sanitizeBlogInsightLine(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^thinking process/i.test(line) &&
      !/^[0-9]+\.\s/.test(line) &&
      !/^<\|/.test(line) &&
      !/^ai[:：]/i.test(line)
    ) || '';
}

export async function buildBlogCliInsight({
  bot,
  requestType,
  title,
  data,
  fallback,
}: {
  bot: string;
  requestType: string;
  title: string;
  data: Record<string, any>;
  fallback: string;
}) {
  try {
    const prompt = `당신은 블로그 운영 결과 분석가입니다.
아래 결과를 보고 운영자나 에이전트가 바로 읽을 수 있는 핵심 인사이트를 한국어 한 줄로만 작성하세요.
숫자 재나열보다 상태 판단, 후속 조치, 주의 포인트를 짧게 요약하세요.

맥락: ${title}
데이터:
${JSON.stringify(data || {}, null, 2).slice(0, 1800)}`;

    const insight = await generateGemmaPilotText({
      team: 'blog',
      purpose: 'gemma-insight',
      bot,
      requestType,
      prompt,
      maxTokens: 100,
      temperature: 0.35,
      timeoutMs: 10000,
    });
    return sanitizeBlogInsightLine(insight?.content || '') || fallback;
  } catch (error) {
    console.warn(`[${bot}] AI 요약 생략: ${error?.message || error}`);
    return fallback;
  }
}
