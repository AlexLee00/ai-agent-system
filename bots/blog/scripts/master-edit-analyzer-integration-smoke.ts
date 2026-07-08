#!/usr/bin/env tsx

const assert = require('assert/strict');

const collector = require('./collect-final-content.ts');
const analyzer = require('../lib/master-edit-analyzer.ts');

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
    id: 201,
    title: '[에이전트 입문 6강] 초안 제목',
    content: 'AI 에이전트는 도구를 선택하고 실행 결과를 기록합니다.\n초보자는 작은 작업부터 자동화해야 합니다.',
    html_content: '',
    naver_url: 'https://blog.naver.com/example/223456789099',
    publish_date: '2026-06-13',
    created_at: '2026-06-13T06:00:00+09:00',
    status: 'published',
    ...overrides
  };
}

function makeFinalPost() {
  return {
    title: '[에이전트 입문 6강] 최종 제목',
    content: 'AI 에이전트는 도구를 선택하고 실행 결과를 기록합니다.\n초보자는 작은 작업부터 자동화해야 합니다.\n마스터가 독자 질문 예시와 다음 실습 연결 문장을 추가했습니다.',
    html: '',
    url: 'https://blog.naver.com/example/223456789099'
  };
}

function makeCollectorPool(rows: BlogPostFixture[]) {
  const state = {
    completed: new Set<number>(),
    ledgerWrites: [] as AnyRecord[],
    candidateSelectCount: 0
  };
  return {
    __rawQuery: true,
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
        const visible = rows.filter((row: BlogPostFixture) => !state.completed.has(row.id));
        return { rows: visible.slice(0, params[params.length - 1] || visible.length) };
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
        state.ledgerWrites.push({ sql: text, row });
        state.completed.add(row.postId);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

function makeAnalyzerPool(candidates: AnyRecord[] = [], styleRows: AnyRecord[] = []) {
  const state = {
    insertedAnalyses: [] as AnyRecord[],
    candidateSelectCount: 0
  };
  return {
    state,
    async query(schema: string, sql: string, params: any[] = []) {
      const text = String(sql);
      if (text.includes('CREATE TABLE IF NOT EXISTS blog.master_edit_analysis')) {
        return [];
      }
      if (text.includes('FROM blog.posts p') && text.includes('JOIN blog.final_content_checks')) {
        state.candidateSelectCount += 1;
        return candidates
          .filter((row: AnyRecord) => row.status === 'changed')
          .filter((row: AnyRecord) => row.changed === true)
          .filter((row: AnyRecord) => row.final_content_text)
          .filter((row: AnyRecord) => !row.analysis_exists)
          .slice(0, 20);
      }
      if (text.includes('INSERT INTO blog.master_edit_analysis')) {
        const inserted = {
          postId: params[0],
          titleChanged: params[1],
          titleSimilarity: params[2],
          addedRatio: params[3],
          removedRatio: params[4],
          changeRate: params[5],
          primaryType: params[6],
          subTypes: params[7],
          patternSummary: params[8],
          preferenceRule: params[9],
          rawDiff: JSON.parse(params[10])
        };
        state.insertedAnalyses.push(inserted);
        return [];
      }
      if (text.includes('UPDATE blog.posts')) {
        return [];
      }
      if (text.includes('SELECT primary_type, preference_rule')) {
        if (styleRows.length > 0) return styleRows;
        return state.insertedAnalyses.map((row: AnyRecord) => ({
          primary_type: row.primaryType,
          preference_rule: row.preferenceRule,
          title_changed: row.titleChanged,
          change_rate: row.changeRate
        }));
      }
      return [];
    }
  };
}

async function run() {
  const tests = [];
  const finalPost = makeFinalPost();

  const dryPool = makeCollectorPool([makePost()]);
  const dryReport = await collector.runCollectFinalContent(
    { json: true, write: false, dryRun: true, days: 3, limit: 20 },
    {
      pgPool: dryPool,
      fetchFinalContent: async () => finalPost
    }
  );
  assert.equal(dryReport.changed, 1);
  assert.equal(dryReport.results[0].finalContentText, undefined);
  assert.equal(dryReport.results[0].finalTitle, finalPost.title);
  assert.ok(dryReport.results[0].finalContentLength > 0);
  tests.push({
    id: 'TS-B10c-1',
    ok: true,
    name: 'collector dry-run exposes final content length/hash metadata, not full text'
  });

  const writePool = makeCollectorPool([makePost()]);
  const writeReport = await collector.runCollectFinalContent(
    { json: true, write: true, dryRun: false, days: 3, limit: 20 },
    {
      pgPool: writePool,
      fetchFinalContent: async () => finalPost,
      recordFeedback: async (postId: number) => ({ post_id: postId }),
      addVaultEntry: async (entry: AnyRecord) => ({ ok: true, filePath: entry.filePath })
    }
  );
  assert.equal(writeReport.changed, 1);
  assert.equal(writePool.state.ledgerWrites.length, 1);
  assert.match(writePool.state.ledgerWrites[0].sql, /final_content_text/);
  assert.equal(writePool.state.ledgerWrites[0].row.finalTitle, finalPost.title);
  assert.match(writePool.state.ledgerWrites[0].row.finalContentText, /독자 질문 예시/);
  tests.push({
    id: 'TS-B10c-2',
    ok: true,
    name: 'collector write payload includes final_title and normalized final_content_text'
  });

  const analyzerPool = makeAnalyzerPool([
    {
      ...makePost(),
      final_title: finalPost.title,
      final_content_text: finalPost.content,
      final_checked_at: '2026-06-13T08:30:00+09:00',
      changed: true,
      status: 'changed'
    }
  ]);
  const analysisReport = await analyzer.runDailyMasterEditAnalysis({
    pgPool: analyzerPool,
    days: 3,
    classifyEditPattern: async () => ({
      primary_type: 'structure',
      sub_types: ['example'],
      pattern_summary: '독자 질문 예시를 추가한다.',
      preference_rule: '강의 끝에 독자가 바로 따라 할 질문 예시를 넣는다.'
    })
  });
  assert.equal(analysisReport.analyzed, 1);
  assert.equal(analysisReport.skipped, 0);
  assert.equal(analyzerPool.state.insertedAnalyses.length, 1);
  const rawDiff = analyzerPool.state.insertedAnalyses[0].rawDiff;
  assert.ok(rawDiff.wordDiff.added_count > 0 || rawDiff.wordDiff.removed_count > 0);
  tests.push({
    id: 'TS-B10c-3',
    ok: true,
    name: 'analyzer consumes changed final_content_checks rows and stores non-empty diff'
  });

  const skipPool = makeAnalyzerPool([
    { ...makePost({ id: 202 }), final_content_text: '', changed: true, status: 'changed' },
    { ...makePost({ id: 203 }), final_content_text: finalPost.content, changed: false, status: 'unchanged' },
    { ...makePost({ id: 204 }), final_content_text: null, changed: null, status: 'fetch_failed' }
  ]);
  const skipReport = await analyzer.runDailyMasterEditAnalysis({
    pgPool: skipPool,
    days: 3,
    classifyEditPattern: async () => {
      throw new Error('skip rows must not reach classifier');
    }
  });
  assert.equal(skipReport.analyzed, 0);
  assert.equal(skipReport.skipped, 0);
  assert.equal(skipPool.state.insertedAnalyses.length, 0);
  tests.push({
    id: 'TS-B10c-4',
    ok: true,
    name: 'analyzer skips missing final body, unchanged, and fetch_failed rows without errors'
  });

  const stylePool = makeAnalyzerPool([], [
    {
      primary_type: 'structure',
      preference_rule: '강의 끝에 다음 실습으로 이어지는 한 문장을 추가한다.',
      title_changed: true,
      change_rate: 0.23
    }
  ]);
  const profile = await analyzer.buildMasterStyleProfile({ pgPool: stylePool, limit: 10 });
  const promptGuide = analyzer.formatStyleProfileForPrompt(profile);
  assert.ok(promptGuide.length > 0);
  assert.match(promptGuide, /마스터 스타일 학습 가이드/);
  tests.push({
    id: 'TS-B10c-5',
    ok: true,
    name: 'master style profile produces non-empty prompt guide from analysis rows'
  });

  const report = {
    ok: tests.every((test) => test.ok),
    suite: 'master-edit-analyzer-integration',
    tests
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    suite: 'master-edit-analyzer-integration',
    error: error && error.stack ? error.stack : String(error)
  }, null, 2));
  process.exit(1);
});
