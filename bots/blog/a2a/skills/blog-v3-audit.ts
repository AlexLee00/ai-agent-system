// @ts-nocheck
import { createRequire } from 'module';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

const require = createRequire(import.meta.url);

export function registerBlogV3AuditSkill(): void {
  registerSkillHandler('blog-v3-audit', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { title?: string; content?: string; category?: string };
    const title = p?.title || 'Blog V3 Audit Draft';
    const content = p?.content || '';
    const category = p?.category || '최신IT트렌드';
    const { generateHomeFeedReport } = require('../../lib/naver-home-feed-optimizer.ts');
    const { detectAiSignals } = require('../../lib/humanize-agent.ts');

    const [homeFeed, humanize] = await Promise.all([
      generateHomeFeedReport({ title, content, category, hasImages: false }),
      Promise.resolve(detectAiSignals(content)),
    ]);

    return {
      id: '',
      status: 'completed',
      output: {
        ok: true,
        skill: 'blog-v3-audit',
        shadowMode: true,
        title,
        category,
        homeFeed,
        humanize,
        checkedAt: new Date().toISOString(),
      },
    };
  });
}
