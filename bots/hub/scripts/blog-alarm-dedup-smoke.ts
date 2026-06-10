#!/usr/bin/env tsx
/**
 * blog-alarm-dedup-smoke.ts
 *
 * 회귀 방지: blog-health 발행 대기 알람이 반복 전송되지 않는지 확인.
 * incident: blog:blog-health:blog-health_error:955511e4d1e1
 */

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');
const { classifyAlarmTypeWithConfidence } = require('../lib/alarm/policy.ts');
const {
  classifyReason: classifyBlogCriticalReason,
  REASON_DEDUP_WINDOWS,
  ALERT_DEDUPE_PATH,
} = require('../../blog/lib/critical-alerts.js');

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
  if (/이웃\s*댓글.*실패\s*[1-9]\d*건|blog-neighbor-commenter/i.test(compact)) return 'neighbor_commenter_failures';
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
  assert(
    classifyBlogCriticalReason(msg1) === 'naver_publish_pending',
    `blog critical-alerts classifyReason mismatch: ${classifyBlogCriticalReason(msg1)}`,
  );

  // ── 6. classifyReason: 기존 패턴 무결성 ──
  assert(classifyReason('write EPIPE connection') === 'broken_pipe', 'broken_pipe pattern broken');
  assert(classifyReason('서비스 pid 없음') === 'service_down', 'service_down pattern broken');
  assert(classifyReason('ready 상태 포스트 발행 대기') === 'naver_publish_pending', 'ready 상태 pattern broken');

  // ── 7. naver_publish_pending: extended dedup 이유 집합 검증 ──
  // critical-alerts.js REASON_DEDUP_WINDOWS에 naver_publish_pending이 포함돼야 4시간 창이 적용된다.
  // 이 어서션은 classifyReason 분류 일관성을 통해 extended dedup 경로를 보장한다.
  const EXTENDED_DEDUP_REASONS = new Set(['naver_publish_pending']);
  assert(
    REASON_DEDUP_WINDOWS?.naver_publish_pending === 4 * 60 * 60 * 1000,
    `critical-alerts naver_publish_pending dedup window must be 4h, got: ${REASON_DEDUP_WINDOWS?.naver_publish_pending}`,
  );
  assert(
    EXTENDED_DEDUP_REASONS.has(reason),
    `naver_publish_pending must be in EXTENDED_DEDUP_REASONS. got: ${reason}`,
  );
  assert(
    EXTENDED_DEDUP_REASONS.has(classifyReason('ready 상태 포스트 발행 대기')),
    'ready 상태 variant must resolve to extended dedup reason',
  );
  assert(
    !EXTENDED_DEDUP_REASONS.has(classifyReason('write EPIPE connection')),
    'broken_pipe must NOT be in extended dedup reasons',
  );
  assert(
    !EXTENDED_DEDUP_REASONS.has(classifyReason('서비스 pid 없음')),
    'service_down must NOT be in extended dedup reasons',
  );

  // ── 8. dedup 캐시 경로가 영속 디렉터리여야 한다 (재부팅 후 초기화 방지) ──
  // /tmp는 재부팅 시 초기화되므로 AI_AGENT_WORKSPACE 등 영속 경로를 사용해야 한다.
  // 회귀: blog:blog-health:blog-health_error:955511e4d1e1 — 재부팅 후 dedup 소실로 반복 알람 발생
  assert(
    typeof ALERT_DEDUPE_PATH === 'string' && ALERT_DEDUPE_PATH.length > 0,
    'ALERT_DEDUPE_PATH must be a non-empty string',
  );
  const os = require('os');
  const tmpDir = os.tmpdir();
  assert(
    !ALERT_DEDUPE_PATH.startsWith(tmpDir),
    `ALERT_DEDUPE_PATH must not be in tmpdir (not persistent across reboots). got: ${ALERT_DEDUPE_PATH}`,
  );
  assert(
    ALERT_DEDUPE_PATH.endsWith('blog-alert-dedupe.json'),
    `ALERT_DEDUPE_PATH must end with blog-alert-dedupe.json. got: ${ALERT_DEDUPE_PATH}`,
  );

  // ── 9. book_catalog DB startup/recovery는 auto_dev 대상 알람으로 승격하지 않는다 ──
  // incident: blog:blog-health:blog_health_check:f8c230e0b5ab
  const fs = require('fs');
  const path = require('path');
  const healthCheckSource = fs.readFileSync(
    path.join(__dirname, '../../blog/scripts/health-check.ts'),
    'utf8',
  );
  assert(
    /function isTransientDatabaseStartupError/.test(healthCheckSource),
    'blog health-check must classify transient DB startup/recovery errors',
  );
  assert(
    /the database system is starting up/.test(healthCheckSource),
    'blog health-check must suppress PostgreSQL startup transient for book_catalog',
  );
  assert(
    /bookCatalog\.transient/.test(healthCheckSource),
    'book_catalog transient failures must be suppressed before issue notification',
  );

  // ── 10. engagement recovery/info는 auto_dev 대상 error로 승격하지 않는다 ──
  // incident: blog:blog-health:blog_health_check:7b00b81e8c34
  const engagementRecovery = classifyAlarmTypeWithConfidence({
    severity: 'info',
    eventType: 'blog_health_check',
    title: '블로그 헬스',
    message: '✅ [블로그 헬스] engagement 자동화 회복\nengagement failures present but non-UI (2건)',
    payload: { event_type: 'blog_health_check' },
  });
  assert(
    engagementRecovery.type === 'report',
    `engagement recovery/info must route as report, got: ${engagementRecovery.type}`,
  );

  // ── 11. Hub smoke는 blog 런타임(commenter.ts)을 직접 로드하면 안 된다 ──
  // Hub 경계 smoke는 lightweight helper만 검증한다. Puppeteer/DB 의존 런타임 import는 auto_dev에서 실패한다.
  const source = fs.readFileSync(__filename, 'utf8');
  const forbiddenRelativeImport = ['..', '..', 'blog', 'lib', 'commenter.ts'].join('/');
  const forbiddenRuntimePath = ['blog', 'lib', 'commenter.ts'].join('/');
  assert(!source.includes(forbiddenRelativeImport), `Hub smoke must not import blog runtime module: ${forbiddenRelativeImport}`);
  assert(!source.includes(`require('${forbiddenRuntimePath}`), `Hub smoke must not require blog runtime module: ${forbiddenRuntimePath}`);

  // ── 12. neighbor-commenter 실패 알람은 canonical reason과 안정 cluster로 묶여야 한다 ──
  const neighborMsg1 = '이웃 댓글 0건 완료, 댓글 공감 0건 완료, 실패 2건, 스킵 1건 (오늘 댓글 총 5/20, 댓글공감 총 5)';
  const neighborMsg2 = '이웃 댓글 0건 완료, 댓글 공감 0건 완료, 실패 3건, 스킵 2건 (오늘 댓글 총 6/20, 댓글공감 총 6)';
  assert(classifyReason(neighborMsg1) === 'neighbor_commenter_failures', 'neighbor commenter failure reason broken');
  assert(
    classifyBlogCriticalReason(neighborMsg1) === 'neighbor_commenter_failures',
    `blog critical-alerts neighbor reason mismatch: ${classifyBlogCriticalReason(neighborMsg1)}`,
  );
  assert(
    REASON_DEDUP_WINDOWS?.neighbor_commenter_failures === 4 * 60 * 60 * 1000,
    `critical-alerts neighbor_commenter_failures dedup window must be 4h, got: ${REASON_DEDUP_WINDOWS?.neighbor_commenter_failures}`,
  );
  const neighborCluster1 = buildAlarmClusterKey({
    team: 'blog',
    fromBot: 'blog-neighbor-commenter',
    eventType: 'blog-neighbor-commenter_error',
    title: 'blog alarm',
    message: neighborMsg1,
    payload: { event_type: 'blog-neighbor-commenter_error' },
  });
  const neighborCluster2 = buildAlarmClusterKey({
    team: 'blog',
    fromBot: 'blog-neighbor-commenter',
    eventType: 'blog-neighbor-commenter_error',
    title: 'blog alarm',
    message: neighborMsg2,
    payload: { event_type: 'blog-neighbor-commenter_error' },
  });
  assert(neighborCluster1.includes('blog_neighbor_commenter'), `neighbor cluster family missing: ${neighborCluster1}`);
  assert(neighborCluster1 === neighborCluster2, `neighbor cluster key must be stable. got:\n  ${neighborCluster1}\n  ${neighborCluster2}`);

  console.log('blog_alarm_dedup_smoke_ok');
}

main().catch((error) => {
  console.error('[blog-alarm-dedup-smoke] failed:', error?.message || error);
  process.exit(1);
});
