#!/usr/bin/env tsx

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const collector = require('./collect-final-content.ts');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

type AnyRecord = Record<string, any>;
type BlogPostFixture = AnyRecord & {
  id: number;
  title: string;
  content: string;
  html_content: string;
  naver_url: string;
};

function makePost(overrides: Partial<BlogPostFixture> = {}): BlogPostFixture {
  return {
    id: 101,
    title: '[에이전트 입문 5강] 초안 제목',
    content: '오늘은 AI 에이전트가 도구를 선택하는 과정을 설명합니다.\n실습에서는 작업을 쪼개고 로그를 남기는 방법을 봅니다.',
    html_content: '',
    naver_url: 'https://blog.naver.com/example/223456789012',
    publish_date: '2026-06-13',
    created_at: '2026-06-13T06:00:00+09:00',
    ...overrides
  };
}

function makeFixtureHtml({ changed = true }: { changed?: boolean } = {}) {
  const body = changed
    ? '오늘은 AI 에이전트가 도구를 선택하는 과정을 설명합니다.<br>실습에서는 작업을 쪼개고 로그를 남기는 방법을 봅니다.<br>마스터가 최종 발행 전에 독자 질문 예시를 추가했습니다.'
    : '오늘은 AI 에이전트가 도구를 선택하는 과정을 설명합니다.<br>실습에서는 작업을 쪼개고 로그를 남기는 방법을 봅니다.';
  return `
    <html>
      <head>
        <meta property="og:title" content="${changed ? '[에이전트 입문 5강] 최종 제목' : '[에이전트 입문 5강] 초안 제목'}">
        <title>fallback title</title>
      </head>
      <body>
        <div id="postViewArea">${body}</div>
      </body>
    </html>
  `;
}

function makeFakePool(rows: BlogPostFixture[]) {
  const state = {
    completed: new Map<number, string>(),
    ledgerWrites: [] as AnyRecord[],
    candidateSelectCount: 0,
    lastCandidateSql: ''
  };
  return {
    state,
    async query(sql: string, params: any[] = []) {
      const text = String(sql);
      if (text.includes('to_regclass')) {
        return { rows: [{ regclass: params[0] }] };
      }
      if (text.includes('information_schema.columns')) {
        return {
          rows: [
            { column_name: 'final_title' },
            { column_name: 'final_content_text' }
          ]
        };
      }
      if (text.includes('FROM blog.posts')) {
        state.candidateSelectCount += 1;
        state.lastCandidateSql = text;
        const visibleRows = rows.filter((row: BlogPostFixture) => !['changed', 'unchanged'].includes(state.completed.get(row.id) || ''));
        return { rows: visibleRows.slice(0, params[params.length - 1] || visibleRows.length) };
      }
      if (text.includes('INSERT INTO blog.final_content_checks')) {
        const row = {
          postId: params[0],
          naverUrl: params[1],
          status: params[2],
          changed: params[3],
          originalContentHash: params[4],
          finalContentHash: params[5],
          finalTitle: params[6],
          finalContentText: params[7],
          diffSummary: params[8],
          vaultFilePath: params[9],
          metadata: JSON.parse(params[10] || '{}')
        };
        state.ledgerWrites.push(row);
        state.completed.set(row.postId, row.status);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

async function run() {
  const tests: AnyRecord[] = [];

  const finalPost = collector.extractNaverPostFromHtml(makeFixtureHtml({ changed: true }));
  assert.equal(finalPost.title, '[에이전트 입문 5강] 최종 제목');
  assert.match(finalPost.content, /독자 질문 예시/);

  const noisyPayload = collector._testOnly.extractNaverPostFromPayload({
    title: 'noise title',
    ogTitle: '[에이전트 입문 5강] 최종 제목',
    text: '네이버 메뉴 공지 추천글 댓글 목록 '.repeat(20),
    html: makeFixtureHtml({ changed: true }),
    url: 'https://blog.naver.com/example/223456789012'
  });
  assert.match(noisyPayload.content, /독자 질문 예시/);
  assert.doesNotMatch(noisyPayload.content, /네이버 메뉴/);
  tests.push({ id: 'TS-B9-1', ok: true, name: 'fixture HTML title/body extraction' });

  const changedDiff = collector.computeContentDiff(makePost().content, finalPost.content);
  const unchangedDiff = collector.computeContentDiff(makePost().content, collector.extractNaverPostFromHtml(makeFixtureHtml({ changed: false })).content);
  assert.equal(changedDiff.changed, true);
  assert.equal(unchangedDiff.changed, false);
  assert.equal(unchangedDiff.diffSummary, 'no_change');
  tests.push({
    id: 'TS-B9-2',
    ok: true,
    name: 'changed and unchanged diff detection',
    detail: { changedSummary: changedDiff.diffSummary, unchangedSummary: unchangedDiff.diffSummary }
  });

  const dryPool = makeFakePool([makePost()]);
  const dryReport = await collector.runCollectFinalContent(
    { json: true, write: false, dryRun: true, days: 3, limit: 20 },
    {
      pgPool: dryPool,
      fetchFinalContent: async () => finalPost,
      recordFeedback: async () => {
        throw new Error('dry-run must not record feedback');
      },
      addVaultEntry: async () => {
        throw new Error('dry-run must not write vault');
      }
    }
  );
  assert.equal(dryReport.dryRun, true);
  assert.equal(dryReport.changed, 1);
  assert.equal(dryPool.state.ledgerWrites.length, 0);
  assert.match(dryPool.state.lastCandidateSql, /< CURRENT_DATE/);
  tests.push({ id: 'TS-B9-3', ok: true, name: 'dry-run blocks master_feedback and vault writes' });

  const writePool = makeFakePool([makePost()]);
  const feedbackWrites: AnyRecord[] = [];
  const vaultWrites: AnyRecord[] = [];
  const writeReport = await collector.runCollectFinalContent(
    { json: true, write: true, dryRun: false, days: 3, limit: 20 },
    {
      pgPool: writePool,
      fetchFinalContent: async () => finalPost,
      recordFeedback: async (postId: number, originalTitle: string, finalTitle: string, originalHash: string, finalHash: string) => {
        feedbackWrites.push({ postId, originalTitle, finalTitle, originalHash, finalHash });
        return { post_id: postId };
      },
      addVaultEntry: async (entry: AnyRecord) => {
        vaultWrites.push(entry);
        return { ok: true, filePath: entry.filePath };
      }
    }
  );
  assert.equal(writeReport.writeEnabled, true);
  assert.equal(writeReport.changed, 1);
  assert.equal(feedbackWrites.length, 1);
  assert.equal(vaultWrites.length, 1);
  assert.equal(vaultWrites[0].source, 'blo');
  assert.equal(vaultWrites[0].type, 'master_edit');
  assert.match(vaultWrites[0].filePath, /^library\/blo\/master_edit\/101-/);
  assert.equal(writePool.state.ledgerWrites[0].status, 'changed');
  tests.push({
    id: 'TS-B9-4',
    ok: true,
    name: 'changed post writes master_feedback, vault entry, and ledger',
    detail: { vaultFilePath: vaultWrites[0].filePath }
  });

  const secondReport = await collector.runCollectFinalContent(
    { json: true, write: true, dryRun: false, days: 3, limit: 20 },
    {
      pgPool: writePool,
      fetchFinalContent: async () => {
        throw new Error('completed ledger row should hide candidate');
      },
      recordFeedback: async () => {
        throw new Error('completed ledger row should prevent duplicate feedback');
      },
      addVaultEntry: async () => {
        throw new Error('completed ledger row should prevent duplicate vault writes');
      }
    }
  );
  assert.equal(secondReport.processed, 0);
  assert.equal(feedbackWrites.length, 1);
  assert.equal(vaultWrites.length, 1);
  tests.push({ id: 'TS-B9-5', ok: true, name: 'ledger idempotency prevents duplicate parsing/writes' });

  const unchangedPool = makeFakePool([makePost()]);
  const unchangedReport = await collector.runCollectFinalContent(
    { json: true, write: true, dryRun: false, days: 3, limit: 20 },
    {
      pgPool: unchangedPool,
      fetchFinalContent: async () => collector.extractNaverPostFromHtml(makeFixtureHtml({ changed: false })),
      recordFeedback: async () => {
        throw new Error('unchanged post must not record feedback');
      },
      addVaultEntry: async () => {
        throw new Error('unchanged post must not write vault');
      }
    }
  );
  assert.equal(unchangedReport.unchanged, 1);
  assert.equal(unchangedPool.state.ledgerWrites[0].status, 'unchanged');
  assert.equal(unchangedPool.state.ledgerWrites[0].changed, false);
  tests.push({ id: 'TS-B9-6', ok: true, name: 'unchanged posts write ledger only' });

  const titleOnlyResult = await collector.processFinalContentCandidate(makePost(), {}, {
    fetchFinalContent: async () => ({
      title: '[에이전트 입문 5강] 제목만 수정',
      content: makePost().content,
      html: '',
      url: makePost().naver_url,
    }),
  });
  assert.equal(titleOnlyResult.changed, true);
  assert.equal(titleOnlyResult.metadata.titleChanged, true);
  assert.match(titleOnlyResult.diffSummary, /^title_changed:/);
  tests.push({ id: 'TS-B9-7', ok: true, name: 'title-only master edit enters feedback loop' });

  const learner = require('../lib/feedback-learner.ts');
  const weeklyEvolutionSource = fs.readFileSync(path.join(PROJECT_ROOT, 'bots/blog/scripts/weekly-evolution.ts'), 'utf8');
  assert.equal(typeof learner.aggregatePatterns, 'function');
  assert.match(weeklyEvolutionSource, /aggregatePatterns\s*\(/);
  tests.push({ id: 'TS-B9-8', ok: true, name: 'weekly-evolution aggregatePatterns consumer path remains wired' });

  const report = {
    ok: tests.every((test) => test.ok),
    suite: 'final-content-diff',
    changedDiffSamples: 2,
    duplicateUnchangedWrites: 0,
    tests
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

run().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    suite: 'final-content-diff',
    error: error instanceof Error && error.stack ? error.stack : String(error)
  }, null, 2));
  process.exit(1);
});
