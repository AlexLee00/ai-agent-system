#!/usr/bin/env tsx
/**
 * blog-alarm-dedup-smoke.ts
 *
 * 회귀 방지: blog-health 발행 대기 알람이 반복 전송되지 않는지 확인.
 * incident: blog:blog-health:blog-health_error:955511e4d1e1
 */

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── hub-alarm-client 유닛 테스트 (private 함수를 인라인 검증) ──────────────

function slugToken(value: unknown, fallback = 'alarm'): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function stableHash(value: unknown): string {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12);
}

function deriveIncidentKey({
  incidentKey,
  team,
  fromBot,
  eventType,
  message,
}: {
  incidentKey?: string;
  team: string;
  fromBot: string;
  eventType: string;
  message: string;
}): string {
  const explicit = String(incidentKey ?? '').trim();
  if (explicit) return explicit;
  const headline = String(message ?? '').trim().split('\n')[0].slice(0, 120);
  return [
    slugToken(team, 'general'),
    slugToken(fromBot, 'unknown'),
    slugToken(eventType, 'alarm'),
    stableHash(headline),
  ].join(':');
}

function classifyReason(message: string): string {
  const compact = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (/write EPIPE|broken pipe/i.test(compact)) return 'broken_pipe';
  if (/http 실패|응답 없음/i.test(compact)) return 'http_failure';
  if (/비정상 종료/i.test(compact)) return 'abnormal_exit';
  if (/미로드/i.test(compact)) return 'launchd_unloaded';
  if (/pid 없음|다운/i.test(compact)) return 'service_down';
  if (/발행 대기|미발행|ready 상태|naver.*publish/i.test(compact)) return 'naver_publish_pending';
  return 'other';
}

async function main() {
  // ── 1. incident_key 안정성: 샘플 포스트 목록이 달라도 같은 첫 줄이면 동일 key ──
  const headline = '⚠️ [블로그 헬스] 네이버 발행 대기 이슈';
  const msg1 = [
    headline,
    'ready 상태 미발행 포스트 4건',
    'sample: Sun Apr 26 general #152 [성장과성공] 도서리뷰',
  ].join('\n');
  const msg2 = [
    headline,
    'ready 상태 미발행 포스트 5건',
    'sample: Mon Apr 27 general #153 [Node.js 77강] GraphQL',
    'sample: Sat Apr 25 general #150 [도서리뷰] 초등 3학년',
  ].join('\n');

  const key1 = deriveIncidentKey({ team: 'blog', fromBot: 'blog-health', eventType: 'blog_health_check', message: msg1 });
  const key2 = deriveIncidentKey({ team: 'blog', fromBot: 'blog-health', eventType: 'blog_health_check', message: msg2 });
  assert(key1 === key2, `incident_key must be stable across varying detail lines. got:\n  ${key1}\n  ${key2}`);

  // ── 2. 다른 종류 에러는 다른 key ──
  const keyOther = deriveIncidentKey({ team: 'blog', fromBot: 'blog-health', eventType: 'blog_health_check', message: '⚠️ [블로그 헬스] 노드 서버 응답 없음' });
  assert(key1 !== keyOther, 'different headline must produce different incident_key');

  // ── 3. cluster family = blog_publish for 발행 대기 ──
  const clusterKey = buildAlarmClusterKey({
    team: 'blog',
    fromBot: 'blog-health',
    eventType: 'blog_health_check',
    title: '블로그 헬스',
    message: msg1,
    payload: { event_type: 'blog_health_check' },
  });
  assert(typeof clusterKey === 'string', 'cluster key must be a string');
  assert(clusterKey.includes('blog_publish'), `cluster key must include blog_publish family, got: ${clusterKey}`);

  // ── 4. cluster key 안정성: 메시지 내용이 달라도 blog_publish family는 동일 cluster ──
  const clusterKey2 = buildAlarmClusterKey({
    team: 'blog',
    fromBot: 'blog-health',
    eventType: 'blog_health_check',
    title: '블로그 헬스',
    message: msg2,
    payload: { event_type: 'blog_health_check' },
  });
  assert(clusterKey === clusterKey2, `blog_publish cluster key must be stable across message variations. got:\n  ${clusterKey}\n  ${clusterKey2}`);

  // ── 5. classifyReason: 발행 대기 → naver_publish_pending ──
  const reason = classifyReason(msg1);
  assert(reason === 'naver_publish_pending', `expected naver_publish_pending reason, got: ${reason}`);

  // ── 6. classifyReason: 기존 패턴 무결성 ──
  assert(classifyReason('write EPIPE connection') === 'broken_pipe', 'broken_pipe pattern broken');
  assert(classifyReason('서비스 pid 없음') === 'service_down', 'service_down pattern broken');
  assert(classifyReason('ready 상태 포스트 발행 대기') === 'naver_publish_pending', 'ready 상태 pattern broken');

  console.log('blog_alarm_dedup_smoke_ok');
}

main().catch((error) => {
  console.error('[blog-alarm-dedup-smoke] failed:', error?.message || error);
  process.exit(1);
});
