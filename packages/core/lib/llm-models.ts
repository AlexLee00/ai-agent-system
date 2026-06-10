// @ts-nocheck
import fs from 'fs';
import path from 'path';

function findProjectRoot() {
  const starts = [
    process.env.PROJECT_ROOT,
    process.env.CODEX_PROJECT_ROOT,
    process.cwd(),
  ].filter(Boolean) as string[];

  for (const start of starts) {
    let current = path.resolve(start);
    while (true) {
      if (fs.existsSync(path.join(current, 'packages/core/lib/llm-models.json'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return process.cwd();
}

const CONFIG_PATH = path.join(findProjectRoot(), 'packages/core/lib/llm-models.json');
let _cache: any = null;

export function loadModels() {
  if (!_cache) {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return _cache;
}

export function getCurrentModel(abstractModel: string): string {
  return loadModels().models[abstractModel]?.current ?? 'claude-haiku-4-5-20251001';
}

export function getGroqFallback(abstractModel: string): string {
  return loadModels().groq_fallback_models[abstractModel]?.current ?? 'llama-3.3-70b-versatile';
}

export function getCost(abstractModel: string, tokensIn: number, tokensOut: number): number {
  const m = loadModels().models[abstractModel];
  if (!m) return 0;
  return (tokensIn * m.cost_per_1m_input_usd / 1_000_000) + (tokensOut * m.cost_per_1m_output_usd / 1_000_000);
}

export function reloadModels() { _cache = null; }

export function getAllModels() { return loadModels().models; }
