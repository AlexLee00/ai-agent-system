// @ts-nocheck
/**
 * scripts/test-korean-quality.js — LLM 모델별 한국어 품질 테스트
 *
 * 동일한 프롬프트를 여러 모델에 보내고 결과 비교.
 * gpt-oss-20b가 클로드 팀장·아처·블로팀 폴백으로 사용되기 전 사전 검증.
 *
 * 실행: node scripts/test-korean-quality.js
 *       node scripts/test-korean-quality.js --models=gpt-4o,gpt-oss-20b
 *       node scripts/test-korean-quality.js --prompt=0   (특정 프롬프트만)
 */

import { callWithFallback } from '../packages/core/lib/llm-fallback.js';

const TEST_PROMPTS = [
  {
    name: '시스템 이슈 트리아지 (클로드 팀장 용도)',
    system: '당신은 시스템 관리 봇입니다. 이슈를 분석하고 반드시 JSON으로만 응답하세요.',
    user: '덱스터가 감지한 이슈: PostgreSQL 커넥션 풀 70% 사용 중, 평소 대비 2배. 심각도를 평가하고 조치 방안을 제시하세요.\nJSON 형식: { "severity": "low|medium|high|critical", "action": "조치설명", "reasoning": "이유" }',
  },
  {
    name: '기술 트렌드 분석 (아처 용도)',
    system: '당신은 기술 인텔리전스 봇입니다. 반드시 JSON으로만 응답하세요.',
    user: 'Node.js v22.15.0이 릴리스되었습니다. 주요 변경사항을 분석하고 우리 시스템에 미치는 영향을 평가하세요.\nJSON 형식: { "patches": [{"package":"이름","priority":"low|medium|high","reason":"이유"}], "summary": "요약" }',
  },
  {
    name: '블로그 포스팅 서론 (블로팀 용도)',
    system: '당신은 15년 경력 시니어 IT 컨설턴트 승호아빠입니다. 블로그 독자들에게 친근하게 말하는 스타일.',
    user: '오늘 날씨는 맑고 기온 15도입니다. Node.js 이벤트 루프에 대한 블로그 포스팅 인사말 단락을 300자 이내로 작성하세요. JSON 없이 자연스러운 한국어 산문으로.',
  },
];

const ALL_MODELS = [
  { provider: 'openai', model: 'gpt-4o',                                    label: 'gpt-4o (기준)' },
  { provider: 'groq',   model: 'openai/gpt-oss-20b',                        label: 'gpt-oss-20b (OpenAI 오픈소스, Groq 경유)' },
  { provider: 'groq',   model: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'llama-4-scout' },
  { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash',        label: 'gemini-2.5-flash' },
];

function parseArgs() {
  const args    = process.argv.slice(2);
  const modelArg = args.find(a => a.startsWith('--models='));
  const promptArg = args.find(a => a.startsWith('--prompt='));

  const modelLabels = modelArg?.split('=')?.[1]?.split(',') || null;
  const promptIdx   = promptArg != null ? parseInt(promptArg.split('=')[1]) : null;

  return { modelLabels, promptIdx };
}

async function runTest() {
  const { modelLabels, promptIdx } = parseArgs();

  const models  = modelLabels
    ? ALL_MODELS.filter(m => modelLabels.some(l => m.label.includes(l) || m.model.includes(l)))
    : ALL_MODELS;

  const prompts = promptIdx != null
    ? [TEST_PROMPTS[promptIdx]].filter(Boolean)
    : TEST_PROMPTS;

  console.log('═'.repeat(70));
  console.log('  LLM 모델별 한국어 품질 테스트');
  console.log(`  모델: ${models.map(m => m.label).join(', ')}`);
  console.log(`  프롬프트: ${prompts.length}개`);
  console.log('═'.repeat(70));

  const summary = [];

  for (const prompt of prompts) {
    console.log(`\n\n📝 테스트: ${prompt.name}`);
    console.log('─'.repeat(70));

    for (const model of models) {
      const t0 = Date.now();
      try {
        const { text } = await callWithFallback({
          chain: [{ ...model, maxTokens: 500, temperature: 0.1 }],
          systemPrompt: prompt.system,
          userPrompt:   prompt.user,
          logMeta: { team: 'test', bot: 'korean-quality', requestType: 'quality_test' },
        });

        const latency    = Date.now() - t0;
        const charCount  = text.length;
        const hasKorean  = /[가-힣]/.test(text);
        const isJSON     = text.trim().startsWith('{');
        const jsonOk     = (() => { try { JSON.parse(text.trim()); return true; } catch { return false; } })();

        // 품질 점수 (간이)
        let score = 0;
        if (hasKorean)              score += 3;
        if (charCount > 50)         score += 2;
        if (charCount > 150)        score += 1;
        if (!prompt.user.includes('JSON') || isJSON) score += 2;
        if (!prompt.user.includes('JSON') || jsonOk) score += 2;

        console.log(`\n  🔹 ${model.label.padEnd(25)} (${latency}ms, ${charCount}자, 점수 ${score}/10)`);
        console.log(`     한국어: ${hasKorean ? '✅' : '❌'} | JSON형식: ${isJSON ? '✅' : '-'} | JSON파싱: ${jsonOk ? '✅' : '-'}`);
        console.log(`     응답: ${text.slice(0, 200).replace(/\n/g, ' ')}${text.length > 200 ? '...' : ''}`);

        summary.push({ prompt: prompt.name, model: model.label, latency, charCount, hasKorean, jsonOk, score });

      } catch (e) {
        const latency = Date.now() - t0;
        console.log(`\n  🔹 ${model.label.padEnd(25)} ❌ 실패 (${latency}ms): ${e.message}`);
        summary.push({ prompt: prompt.name, model: model.label, latency, error: e.message, score: 0 });
      }
    }
  }

  // 최종 요약 테이블
  console.log('\n\n' + '═'.repeat(70));
  console.log('  최종 요약');
  console.log('═'.repeat(70));
  console.log('  모델'.padEnd(30) + '평균점수  평균속도  한국어 성공률');
  console.log('  ' + '─'.repeat(65));

  for (const model of models) {
    const rows   = summary.filter(s => s.model === model.label && !s.error);
    if (!rows.length) { console.log(`  ${model.label.padEnd(28)} 전체 실패`); continue; }
    const avgScore   = (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1);
    const avgLatency = Math.round(rows.reduce((s, r) => s + r.latency, 0) / rows.length);
    const korRate    = (rows.filter(r => r.hasKorean).length / rows.length * 100).toFixed(0);
    console.log(`  ${model.label.padEnd(28)} ${avgScore.padEnd(9)} ${String(avgLatency + 'ms').padEnd(9)} ${korRate}%`);
  }

  console.log('\n  💡 판단 기준:');
  console.log('     8~10점: 우수 (폴백 적합)');
  console.log('     5~7점:  보통 (모니터링 필요)');
  console.log('     4점 이하: 불량 (폴백에서 제외 권장)');
}

runTest().catch(e => {
  console.error('테스트 오류:', e.message);
  process.exit(1);
});
