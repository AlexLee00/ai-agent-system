#!/usr/bin/env node
'use strict';

const { getPerformanceCollectionCandidates, recordPerformance } = require('../lib/publ');
const { fetchNaverBlogStats } = require('../lib/richer');

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    days: Number(get('days') || 7),
    limit: Number(get('limit') || 0),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

async function main() {
  const args = parseArgs();
  const rows = await getPerformanceCollectionCandidates(args.days);
  const candidates = args.limit > 0 ? rows.slice(0, args.limit) : rows;

  const results = [];
  let updated = 0;

  for (const post of candidates) {
    try {
      const stats = await fetchNaverBlogStats(post);
      const payload = {
        views: Number(stats.views || 0),
        comments: Number(stats.comments || 0),
        likes: Number(stats.likes || 0),
      };

      if (!args.dryRun) {
        await recordPerformance(post.id, payload);
        updated++;
      }

      results.push({
        ok: true,
        postId: post.id,
        title: post.title,
        ...payload,
        source: stats.source || 'unknown',
        url: stats.url || post.naver_url || null,
      });
    } catch (error) {
      console.warn(`[collect-performance] ${post.id} 실패: ${error.message}`);
      results.push({
        ok: false,
        postId: post.id,
        title: post.title,
        error: error.message,
      });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      candidates: candidates.length,
      updated,
      dryRun: args.dryRun,
      results,
    }, null, 2));
    return;
  }

  console.log(`✅ 성과 수집 완료: ${updated}건 갱신${args.dryRun ? ' (dry-run)' : ''}`);
  results.forEach((item) => {
    if (!item.ok) {
      console.log(`- ❌ ${item.postId} ${item.title}: ${item.error}`);
      return;
    }
    console.log(`- ✅ ${item.postId} ${item.title} | views=${item.views} comments=${item.comments} likes=${item.likes} (${item.source})`);
  });
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
