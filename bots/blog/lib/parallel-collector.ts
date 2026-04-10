// @ts-nocheck
'use strict';

const richer = require('./richer.ts');

function unwrapSettled(result, fallback) {
  return result && result.status === 'fulfilled' ? result.value : fallback;
}

async function collectAllResearch(category = 'general', needsBookInfo = false) {
  const [itNews, nodejsUpdates, weather, popularPatterns, lecturePopularPatterns] = await Promise.allSettled([
    richer.fetchITNews(5),
    richer.fetchNodejsUpdates(),
    richer.fetchWeather(),
    richer.searchPopularPatterns('general'),
    richer.searchPopularPatterns('lecture'),
  ]);

  const result = {
    timestamp: new Date().toISOString(),
    it_news: unwrapSettled(itNews, []),
    nodejs_updates: unwrapSettled(nodejsUpdates, []),
    weather: unwrapSettled(weather, { description: '날씨 정보 없음', temperature: null }),
    category,
    popularPatterns: unwrapSettled(popularPatterns, []),
    lecturePopularPatterns: unwrapSettled(lecturePopularPatterns, []),
    book_info: needsBookInfo
      ? { note: '도서 정보 수집 — 추후 교보/예스24 API 연동 예정' }
      : null,
  };

  console.log(
    `[병렬수집] 완료: IT뉴스 ${result.it_news.length}건, Node.js ${result.nodejs_updates.length}건, ` +
    `일반패턴 ${result.popularPatterns.length}건, 강의패턴 ${result.lecturePopularPatterns.length}건`
  );

  return result;
}

module.exports = {
  collectAllResearch,
};
