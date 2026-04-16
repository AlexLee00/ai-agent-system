// @ts-nocheck
'use strict';

const { registerSkill } = require('../../../packages/core/lib/skill-selector');
const { registerTool } = require('../../../packages/core/lib/tool-selector');

const SKILLS = [
  { name: 'code-review', display_name: '코드리뷰', team: null, category: 'validation', code_path: 'packages/core/lib/skills/code-review.js' },
  { name: 'verify-loop', display_name: '검증루프', team: null, category: 'validation', code_path: 'packages/core/lib/skills/verify-loop.js' },
  { name: 'plan', display_name: '계획수립', team: null, category: 'analysis', code_path: 'packages/core/lib/skills/plan.js' },
  { name: 'security-pipeline', display_name: '보안파이프라인', team: null, category: 'validation', code_path: 'packages/core/lib/skills/security-pipeline.js' },
  { name: 'eval-harness', display_name: '평가하네스', team: null, category: 'validation', code_path: 'packages/core/lib/skills/eval-harness.js' },
  { name: 'session-wrap', display_name: '세션정리', team: null, category: 'transform', code_path: 'packages/core/lib/skills/session-wrap.js' },
  { name: 'build-system', display_name: '빌드시스템', team: null, category: 'generation', code_path: 'packages/core/lib/skills/build-system.js' },
  { name: 'instinct-learning', display_name: '직감학습', team: null, category: 'learning', code_path: 'packages/core/lib/skills/instinct-learning.js' },
  { name: 'pattern-to-skill', display_name: '패턴→스킬', team: null, category: 'learning', code_path: 'packages/core/lib/skills/pattern-to-skill.js' },
  { name: 'skill-explorer', display_name: '스킬탐색', team: null, category: 'search', code_path: 'packages/core/lib/skills/skill-explorer.js' },
  { name: 'session-analyzer', display_name: '세션분석', team: null, category: 'analysis', code_path: 'packages/core/lib/skills/session-analyzer.js' },
  { name: 'tdd', display_name: 'TDD', team: null, category: 'validation', code_path: 'packages/core/lib/skills/tdd.js' },
  { name: 'handoff-verify', display_name: '핸드오프검증', team: null, category: 'validation', code_path: 'packages/core/lib/skills/handoff-verify.js' },
  { name: 'source-ranking', display_name: '출처랭킹', team: 'darwin', category: 'analysis', score: 7.2, code_path: 'packages/core/lib/skills/darwin/source-ranking.js' },
  { name: 'counterexample', display_name: '반례생성', team: 'darwin', category: 'analysis', code_path: 'packages/core/lib/skills/darwin/counterexample.js' },
  { name: 'replicator', display_name: '실험재현', team: 'darwin', category: 'validation', code_path: 'packages/core/lib/skills/darwin/replicator.js' },
  { name: 'synthesis', display_name: '연구종합', team: 'darwin', category: 'generation', code_path: 'packages/core/lib/skills/darwin/synthesis.js' },
  { name: 'source-auditor', display_name: '출처감사', team: 'darwin', category: 'validation', code_path: 'packages/core/lib/skills/darwin/source-auditor.js' },
  { name: 'citation-audit', display_name: '인용감사', team: 'justin', category: 'validation', score: 7.1, code_path: 'packages/core/lib/skills/justin/citation-audit.js' },
  { name: 'evidence-map', display_name: '증거맵핑', team: 'justin', category: 'analysis', code_path: 'packages/core/lib/skills/justin/evidence-map.js' },
  { name: 'judge-simulator', display_name: '판사시뮬', team: 'justin', category: 'analysis', code_path: 'packages/core/lib/skills/justin/judge-simulator.js' },
  { name: 'precedent-comparer', display_name: '판례비교', team: 'justin', category: 'search', code_path: 'packages/core/lib/skills/justin/precedent-comparer.js' },
  { name: 'damages-analyst', display_name: '손해분석', team: 'justin', category: 'analysis', code_path: 'packages/core/lib/skills/justin/damages-analyst.js' },
  { name: 'data-quality-guard', display_name: '데이터품질', team: 'sigma', category: 'validation', score: 7.0, code_path: 'packages/core/lib/skills/sigma/data-quality-guard.js' },
  { name: 'experiment-design', display_name: '실험설계', team: 'sigma', category: 'analysis', code_path: 'packages/core/lib/skills/sigma/experiment-design.js' },
  { name: 'causal-check', display_name: '인과검증', team: 'sigma', category: 'validation', code_path: 'packages/core/lib/skills/sigma/causal-check.js' },
  { name: 'feature-planner', display_name: '피처계획', team: 'sigma', category: 'analysis', code_path: 'packages/core/lib/skills/sigma/feature-planner.js' },
  { name: 'observability-planner', display_name: '관측성계획', team: 'sigma', category: 'analysis', code_path: 'packages/core/lib/skills/sigma/observability-planner.js' },
];

const TOOLS = [
  { name: 'alpha-vantage-mcp', display_name: 'Alpha Vantage', type: 'mcp', team: 'luna', score: 6.8, endpoint: 'https://mcp.alphavantage.co/mcp', capabilities: ['market_data', 'stock_quote', 'forex', 'crypto', 'technical_indicators', 'news_sentiment'] },
  { name: 'binance-api', display_name: '바이낸스API', type: 'api', team: 'luna', endpoint: 'internal', capabilities: ['trade', 'market_data', 'wallet', 'order'] },
  { name: 'kis-api', display_name: '한투API', type: 'api', team: 'luna', endpoint: 'internal', capabilities: ['trade', 'stock_quote', 'balance', 'order'] },
  { name: 'naver-searchad-mcp', display_name: '네이버검색광고', type: 'mcp', team: 'blog', endpoint: 'local', capabilities: ['keyword_search', 'competition', 'related_keywords'] },
  { name: 'naver-blog-api', display_name: '네이버블로그', type: 'api', team: 'blog', endpoint: 'internal', capabilities: ['publish', 'search', 'analytics'] },
  { name: 'github-mcp', display_name: 'GitHub', type: 'mcp', team: 'darwin', score: 6.5, endpoint: 'official', capabilities: ['repo_search', 'issue', 'pr', 'code_search'] },
  { name: 'context7-mcp', display_name: 'Context7', type: 'mcp', team: 'darwin', endpoint: 'official', capabilities: ['doc_search', 'api_reference', 'library_docs'] },
  { name: 'capcut-mcp', display_name: 'CapCut', type: 'mcp', team: 'video', endpoint: 'local:9001', capabilities: ['create_draft', 'add_video', 'add_audio', 'add_text', 'add_image', 'save_draft'] },
  { name: 'mlx-local-llm', display_name: 'MLX로컬LLM', type: 'internal', team: null, endpoint: 'localhost:8000', capabilities: ['text_generation', 'embedding', 'classification'] },
  { name: 'pgvector-rag', display_name: 'pgvector RAG', type: 'internal', team: null, endpoint: 'internal', capabilities: ['vector_search', 'semantic_search', 'rag'] },
  { name: 'desktop-commander', display_name: 'Desktop Commander', type: 'mcp', team: 'claude', endpoint: 'local', capabilities: ['file_read', 'file_write', 'process', 'search'] },
];

async function main() {
  let skillOk = 0;
  let toolOk = 0;
  let fail = 0;

  console.log(`🧠 skill/tool registry seed start (skills=${SKILLS.length}, tools=${TOOLS.length})`);

  for (const skill of SKILLS) {
    try {
      const row = await registerSkill(skill);
      console.log(`  ✅ skill ${row.name} (${row.team || 'shared'}/${row.category})`);
      skillOk += 1;
    } catch (error) {
      console.error(`  ❌ skill ${skill.name}: ${error.message}`);
      fail += 1;
    }
  }

  for (const tool of TOOLS) {
    try {
      const row = await registerTool(tool);
      console.log(`  ✅ tool ${row.name} (${row.team || 'shared'}/${row.type})`);
      toolOk += 1;
    } catch (error) {
      console.error(`  ❌ tool ${tool.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🧠 seed complete: skills=${skillOk}, tools=${toolOk}, fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
