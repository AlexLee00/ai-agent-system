// @ts-nocheck
/**
 * check-llm-model-updates.ts
 * 매주 일요일 12:00 KST — ai.hub.llm-model-check launchd
 * Anthropic API에서 최신 모델 목록 조회 → 변경 감지 시 Telegram 알림
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const hub = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-client'));
const { getAnthropicKey, publicProviderEnabled } = require(path.join(PROJECT_ROOT, 'packages/core/lib/llm-keys'));

const MODELS_PATH = path.join(PROJECT_ROOT, 'packages/core/lib/llm-models.json');

async function main() {
  console.log('[llm-model-check] 모델 업데이트 확인 시작');

  const config = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf-8'));
  const currentModels = config.models;

  if (!publicProviderEnabled('anthropic')) {
    console.log('[llm-model-check] Anthropic public API 비활성 — 스킵');
    process.exit(0);
  }

  const apiKey = getAnthropicKey();
  if (!apiKey) {
    console.log('[llm-model-check] Anthropic public API 키 없음 — 스킵');
    process.exit(0);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });

    if (!response.ok) {
      console.warn('[llm-model-check] API 호출 실패:', response.status);
      process.exit(0);
    }

    const { data } = await response.json();
    const updates: any[] = [];

    const ALIAS_MAP: Record<string, string[]> = {
      anthropic_haiku: ['claude-haiku'],
      anthropic_sonnet: ['claude-sonnet'],
      anthropic_opus: ['claude-opus'],
    };

    for (const [abstract, cfg] of Object.entries(currentModels) as any) {
      const prefixes = ALIAS_MAP[abstract] || [];
      const latestInApi = data
        .filter((m: any) => prefixes.some(p => m.id.startsWith(p)))
        .sort((a: any, b: any) => b.id.localeCompare(a.id))[0];

      if (latestInApi && latestInApi.id !== cfg.current) {
        updates.push({ abstract, old: cfg.current, new: latestInApi.id });
      }
    }

    if (updates.length > 0) {
      const msg = `🔔 LLM 모델 업데이트 감지!\n${updates.map((u: any) => `• ${u.abstract}: ${u.old} → ${u.new}`).join('\n')}\n\n수동 확인 필요: packages/core/lib/llm-models.json`;
      console.log('[llm-model-check]', msg);
      await hub.callHub('/hub/alarm', { message: msg, channel: 'general' }).catch(() => {});
    } else {
      console.log('[llm-model-check] 모델 업데이트 없음');
    }
  } catch (e: any) {
    console.error('[llm-model-check] 오류:', e.message);
  }

  process.exit(0);
}

main();
