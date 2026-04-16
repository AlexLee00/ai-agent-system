/**
 * ska-llm-parse.ts — 스카팀 LLM 파싱 PortAgent 스크립트
 *
 * Elixir ParsingGuard Level 3에서 PortAgent로 호출됨.
 *
 * 입력 방식 (두 가지 지원):
 *   1. --payload=<base64>  인수 (Elixir System.cmd 경유, 권장)
 *   2. stdin JSON           (기존 방식, 폴백)
 *
 * 입력 JSON:
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

async function readInput(): Promise<string> {
  // --payload=<base64> 인수 우선 (Elixir System.cmd 경유)
  const payloadArg = process.argv.find((a) => a.startsWith('--payload='));
  if (payloadArg) {
    return Buffer.from(payloadArg.slice('--payload='.length), 'base64').toString('utf8');
  }
  // 폴백: stdin 읽기
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

async function main() {
  const raw = await readInput();

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
