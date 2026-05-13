// @ts-nocheck
/**
 * test-groq-fallback.ts
 * 매주 일요일 05:00 KST — Groq 단독 운영 모드 3 모델 테스트
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { callGroqFallback } = require('../lib/llm/groq-fallback.ts');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');

const GROQ_MODEL: Record<string, string> = {
  anthropic_haiku:  'llama-3.1-8b-instant',
  anthropic_sonnet: 'llama-3.3-70b-versatile',
  anthropic_opus:   'qwen/qwen3-32b',
};

async function testGroqFallback() {
  console.log('[groq-test] Groq 단독 운영 모드 테스트 시작');

  const testCases = [
    { abstractModel: 'anthropic_haiku',  prompt: '안녕하세요. 한 문장으로 답변해주세요.' },
    { abstractModel: 'anthropic_sonnet', prompt: '2 + 2는 얼마입니까? 숫자만 답하세요.' },
    { abstractModel: 'anthropic_opus',   prompt: '인공지능이란 무엇인가? 한 문장으로.' },
  ];

  const results = [];
  for (const test of testCases) {
    const start = Date.now();
    try {
      const resp = await callGroqFallback({
        prompt: test.prompt,
        model: GROQ_MODEL[test.abstractModel],
        maxTokens: 64,
        temperature: 0,
      });
      results.push({
        abstract_model: test.abstractModel,
        groq_model: GROQ_MODEL[test.abstractModel],
        ok: resp?.ok !== false,
        duration_ms: Date.now() - start,
        response_length: (resp?.result || '').length,
      });
    } catch (err: any) {
      results.push({ abstract_model: test.abstractModel, ok: false, error: err.message });
    }
  }

  const failed = results.filter(r => !r.ok);
  const msg = failed.length > 0
    ? `🔴 Groq fallback 테스트 실패 (${failed.length}개)\n${failed.map(f => `• ${f.abstract_model}: ${f.error || 'unknown'}`).join('\n')}`
    : `✅ Groq 단독 운영 정상 — ${results.length}개 모델 모두 OK\n${results.map(r => `• ${r.abstract_model}: ${r.duration_ms}ms, ${r.response_length}자`).join('\n')}`;

  console.log('[groq-test]', msg);
  if (process.env.HUB_GROQ_FALLBACK_TEST_NOTIFY !== 'false') {
    await postAlarm({
      team: 'hub',
      fromBot: 'llm-groq-fallback-test',
      alertLevel: failed.length > 0 ? 3 : 1,
      alarmType: failed.length > 0 ? 'error' : 'report',
      visibility: failed.length > 0 ? 'notify' : 'digest',
      title: failed.length > 0 ? 'Groq fallback 테스트 실패' : 'Groq fallback 테스트 정상',
      message: msg,
      eventType: 'llm_groq_fallback_test',
      incidentKey: `hub:llm_groq_fallback_test:${new Date().toISOString().slice(0, 10)}`,
      payload: {
        event_type: 'llm_groq_fallback_test',
        failures: failed.length,
        results,
      },
    }).catch((err: Error) => {
      console.warn('[groq-test] hub alarm failed:', err.message);
    });
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

testGroqFallback();
