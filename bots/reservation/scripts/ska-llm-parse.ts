/**
 * ska-llm-parse.ts — 스카팀 LLM 파싱 PortAgent 스크립트
 *
 * Elixir ParsingGuard Level 3에서 PortAgent로 호출됨.
 * stdin으로 JSON payload 수신 → LLM 호출 → stdout으로 결과 반환.
 *
 * 입력 (stdin JSON):
 *   {
 *     chain_id: 'ska.parsing.level3' | 'ska.selector.generate' | 'ska.classify',
 *     system_prompt: string,
 *     user_prompt: string,
 *     meta: { team, agent, target }
 *   }
 *
 * 출력 (stdout JSON):
 *   { text: string, provider: string, model: string } | { error: string }
 */

'use strict';

const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { SKA_CHAIN_REGISTRY } = require('../lib/ska-llm-chains');

async function main() {
  let raw = '';

  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'invalid_json_input' }));
    process.exit(1);
  }

  const { chain_id, system_prompt, user_prompt, meta = {} } = payload;

  const chain = SKA_CHAIN_REGISTRY[chain_id];
  if (!chain) {
    process.stdout.write(JSON.stringify({ error: `unknown_chain_id: ${chain_id}` }));
    process.exit(1);
  }

  try {
    const result = await callWithFallback({
      chain,
      systemPrompt: system_prompt,
      userPrompt: user_prompt,
      logMeta: {
        team: 'ska',
        bot: meta.agent || 'parsing_guard',
        requestType: chain_id,
        ...meta,
      },
    });

    process.stdout.write(JSON.stringify({
      text: result.text,
      provider: result.provider,
      model: result.model,
    }));
    process.exit(0);
  } catch (err: any) {
    process.stdout.write(JSON.stringify({ error: err?.message || String(err) }));
    process.exit(1);
  }
}

main();
