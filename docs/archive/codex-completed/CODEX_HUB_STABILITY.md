# CODEX_HUB_STABILITY.md — Hub 시스템 안정성 개선 + TS 전환

> 메티 | 2026-04-14 | 코덱스 구현 프롬프트
> 환경: Mac Studio M4 Max 32GB / OPS
> Hub = 팀 제이 전체 시스템의 심장! 가장 중요한 인프라!
> 현재 상태: 자주 다운 + MODULE_NOT_FOUND + rate limit 초과

---

## 1. 현재 문제 분석 (5가지 근본 원인!)

### 문제 1: MODULE_NOT_FOUND 크래시 (치명적!)

```
에러: Cannot find module './runtime-profiles.legacy.js'
경로: dist/ts-runtime/bots/hub/lib/runtime-profiles.js

원인:
  esbuild 빌드 결과물에 .legacy.js 파일이 누락!
  runtime-profiles.ts → require('./runtime-profiles.legacy.js')
  빌드 시 .legacy.js 파일이 dist/에 복사되지 않음!

영향:
  Hub 시작 즉시 크래시 → 전체 에이전트 시스템 마비!
  launchd KeepAlive=true로 재시작 → 같은 에러 → 10초 간격 무한 크래시!
```

### 문제 2: uncaughtException → process.exit(1) (과잉 반응!)

```
현재 코드:
  process.on('uncaughtException', (error) => {
    console.error('[hub] uncaughtException:', error);
    process.exit(1);  // ← 에러 하나로 전체 서버 종료!
  });

문제:
  개별 라우트에서 발생한 에러 하나가 전체 Hub를 죽임!
  예: DB 연결 일시 실패 → 전체 API 다운!
```

### 문제 3: rate limit 429 폭주 (설정 부적합!)

```
hub.log 분석:
  POST /hub/pg/query → 429 (0ms) × 13회 연속!

원인:
  pgLimiter: max 30/분 → Elixir Supervisor 31개 에이전트가 동시 쿼리!
  특히 30분 Diagnostics 리포트 시 한꺼번에 쿼리 폭주!

영향:
  정상 에이전트 쿼리도 429로 거부 → 데이터 손실!
```

### 문제 4: Graceful Shutdown 미구현

```
현재:
  SIGTERM → pg-pool 종료만 → 진행 중 요청 즉시 끊김!
  서버 close() 미호출!
  활성 커넥션 추적 없음!

영향:
  deploy.sh 배포 시 → SIGTERM → 응답 중인 요청 즉시 실패!
  Elixir PortAgent에서 timeout → 재시도 → 불필요한 부하!
```

### 문제 5: JS→TS 미전환 (빌드 취약성!)

```
현재:
  hub.ts → esbuild → dist/ts-runtime/bots/hub/src/hub.js
  .legacy.js 파일이 별도 존재 → 빌드 누락 위험!
  require() 기반 → 타입 안전성 없음!
  package.json "main": "src/hub.js" → TS 경로 불일치!

영향:
  빌드 실패 시 감지 못하고 배포 → 런타임 크래시!
```


---

## 2. 커뮤니티 베스트 프랙티스

### 2-1. Node.js 고가용성 패턴 (업계 표준!)

```
참조:
  Express.js 공식 — Health Checks + Graceful Shutdown!
  PM2 공식 — 프로세스 관리 + 자동 재시작!
  oneuptime — Graceful Shutdown Handler 패턴!
  http-graceful-shutdown (npm, 3.1.15) — 라이브러리!

핵심 패턴:
  1. Graceful Shutdown: SIGTERM → 새 요청 거부 → 진행 중 완료 → 리소스 정리 → exit!
  2. Health Check 3단계: liveness / readiness / startup!
  3. Connection Tracking: 활성 커넥션 Set으로 추적 → 종료 시 정리!
  4. Circuit Breaker: DB 실패 시 전체 서버 죽이지 않고 503 반환!
  5. Process Manager: PM2 cluster mode 또는 launchd KeepAlive!
```

### 2-2. 우리 환경 최적 조합

```
  launchd (이미 사용!) + Graceful Shutdown + Health 3단계!
  PM2 도입 불필요! launchd KeepAlive가 동일 역할!
  단, 현재 KeepAlive=true + ThrottleInterval=10초가
  MODULE_NOT_FOUND 크래시 → 10초 간격 무한 재시작 유발!
  → 크래시 원인 해결이 먼저!
```

---

## 2-3. 2026-04-14 현재 반영 상태

이미 반영된 안정화:

- `runtime-profiles.legacy.js` 의존 제거
- `uncaughtException -> exit(1)` 제거
- `SIGTERM`/`SIGINT` graceful shutdown
- `live / ready / startup` health endpoint 추가
- `pg` overload guard + `Retry-After`
- `ready`와 `services/status`의 코어 서비스 기준 통일
- `/hub/services/status`에서 launchd 전체가 아니라 핵심 서비스만 반환
- 비상주형 서비스는 `down`이 아니라 `idle`로 분리

현재 `idle` 예시:

- `ai.claude.dexter`
- `ai.worker.lead`
- `ai.worker.task-runner`
- `ai.investment.crypto`

즉 현재 허브 운영 화면은:

- `core_down`: 실제 핵심 인프라 장애
- `down`: 점검이 필요한 비정상 서비스
- `idle`: 정상 등록된 비상주/스케줄 대기 서비스

를 구분해서 보여주는 단계까지 올라와 있다.

---

## 3. Phase 0: 즉시 안정화 (긴급!)

### 3-1. MODULE_NOT_FOUND 해결

```typescript
// bots/hub/lib/runtime-profiles.ts 수정!

// 현재: require('./runtime-profiles.legacy.js') → 빌드 누락!
// 변경: .legacy.js 폴백 제거! TS 단일 소스로 통합!

// 방법 1 (추천!): .legacy.js 내용을 .ts에 통합!
//   runtime-profiles.legacy.js의 로직을 runtime-profiles.ts에 합침!
//   require('./runtime-profiles.legacy.js') 제거!

// 방법 2: esbuild 설정에 .legacy.js 파일 복사 추가!
//   빌드 스크립트에 cp 명령 추가!

// 전체 .legacy.js 목록 (같은 패턴!):
//   lib/auth.legacy.js
//   lib/runtime-profiles.legacy.js
//   lib/sql-guard.legacy.js
//   scripts/telegram-callback-poller.legacy.js
//   src/hub.legacy.js

커밋: "fix(hub): MODULE_NOT_FOUND .legacy.js 통합"
```

### 3-2. uncaughtException 개선

```typescript
// bots/hub/src/hub.ts 수정!

// 현재: 에러 하나로 전체 서버 종료!
process.on('uncaughtException', (error) => {
  console.error('[hub] uncaughtException:', error);
  process.exit(1); // ← 삭제!
});

// 변경: 로깅 후 계속 실행! 심각한 경우만 종료!
let uncaughtCount = 0;
process.on('uncaughtException', (error: unknown) => {
  uncaughtCount++;
  console.error(`[hub] uncaughtException #${uncaughtCount}:`, error);

  // 텔레그램 알림!
  postAlarmSync('🚨 Hub uncaughtException 발생!', 'critical');

  // 5분 내 3회 이상 → 심각한 문제 → 재시작!
  if (uncaughtCount >= 3) {
    console.error('[hub] 반복 에러 → 안전 재시작!');
    gracefulShutdown('uncaught_overflow');
  }
  // 그 외에는 계속 실행!
});

process.on('unhandledRejection', (error: unknown) => {
  console.error('[hub] unhandledRejection:', error);
  // 절대 process.exit 하지 않음!
});

커밋: "fix(hub): uncaughtException 과잉 반응 제거"
```

### 3-3. Rate Limit 완화

```typescript
// bots/hub/src/hub.ts 수정!

// 현재: pgLimiter max: 30/분 → 31개 에이전트 동시 쿼리 시 부족!
// 변경: 적절한 수준으로 완화!

const pgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,  // 30 → 120! (에이전트 31개 × 4회/분 여유!)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'DB query rate limit exceeded (120/min)' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,  // 100 → 200!
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded (200/min)' },
});

커밋: "fix(hub): rate limit 완화 (31개 에이전트 대응)"
```


---

## 4. Phase 1: Graceful Shutdown + Health 3단계 (1주!)

### 4-1. Graceful Shutdown 구현

```typescript
// bots/hub/src/hub.ts에 추가!

let server: any;
let isShuttingDown = false;
const activeConnections = new Set<any>();

// 서버 시작 시 커넥션 추적!
server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Resource API Hub 시작 — http://0.0.0.0:${PORT}/hub/health`);
});

server.on('connection', (socket: any) => {
  activeConnections.add(socket);
  socket.on('close', () => activeConnections.delete(socket));
});

// 셧다운 미들웨어: 종료 중이면 새 요청 거부!
app.use((req: any, res: any, next: any) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'server shutting down' });
  }
  next();
});

// Graceful Shutdown!
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[hub] ${signal} 수신 → graceful shutdown 시작...`);

  // 1. 새 요청 거부 (미들웨어에서 처리!)
  // 2. 서버 close (진행 중 요청은 완료!)
  server.close(() => {
    console.log('[hub] HTTP 서버 종료 완료');
  });

  // 3. 10초 후 강제 종료!
  const forceTimeout = setTimeout(() => {
    console.error('[hub] 강제 종료 (10초 타임아웃)');
    activeConnections.forEach(socket => socket.destroy());
    process.exit(1);
  }, 10000);

  // 4. 리소스 정리!
  try {
    await pgPool.close();  // DB 커넥션 풀 정리!
    console.log('[hub] DB 풀 종료 완료');
  } catch (e) {
    console.error('[hub] DB 풀 종료 실패:', e);
  }

  clearTimeout(forceTimeout);
  console.log('[hub] graceful shutdown 완료');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

커밋: "feat(hub): graceful shutdown 구현"
```

### 4-2. Health Check 3단계

```typescript
// bots/hub/lib/routes/health.ts 확장!

// 현재: 단순 200 OK!
// 변경: liveness / readiness / startup 3단계!

// 1. Liveness — 프로세스 살아있나? (launchd 체크용!)
app.get('/hub/health/live', (req, res) => {
  res.json({ status: 'alive', uptime: process.uptime() });
});

// 2. Readiness — 요청 처리 가능한가? (DB 연결 등!)
app.get('/hub/health/ready', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }
  try {
    await pgPool.query('blog', 'SELECT 1');
    res.json({
      status: 'ready',
      uptime: process.uptime(),
      connections: activeConnections.size,
      memory: process.memoryUsage(),
    });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// 3. Startup — 초기화 완료? (시작 직후 체크!)
let startupComplete = false;
app.get('/hub/health/startup', (req, res) => {
  if (startupComplete) {
    res.json({ status: 'started' });
  } else {
    res.status(503).json({ status: 'starting' });
  }
});

// 시작 완료 시 플래그!
server = app.listen(PORT, '0.0.0.0', async () => {
  // DB 연결 확인 후 startup 완료!
  try {
    await pgPool.query('blog', 'SELECT 1');
    startupComplete = true;
    console.log('🌐 Hub startup 완료!');
  } catch {
    console.error('⚠️ Hub 시작되었지만 DB 미연결!');
  }
});

커밋: "feat(hub): health check 3단계 (live/ready/startup)"
```

### 4-3. Elixir 연동 — Hub 상태 모니터링

```elixir
# elixir/team_jay/lib/team_jay/hub_monitor.ex (신규!)

defmodule TeamJay.HubMonitor do
  use GenServer

  @check_interval :timer.seconds(30)
  @hub_url "http://localhost:7788/hub/health/ready"

  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def init(state) do
    schedule_check()
    {:ok, Map.put(state, :consecutive_failures, 0)}
  end

  def handle_info(:check, state) do
    case check_hub_health() do
      :ok ->
        schedule_check()
        {:noreply, %{state | consecutive_failures: 0}}
      :error ->
        failures = state.consecutive_failures + 1
        if failures >= 3 do
          # 3회 연속 실패 → 텔레그램 CRITICAL!
          TeamJay.Alarm.send("🚨 Hub 3회 연속 응답 없음!", :critical)
        end
        schedule_check()
        {:noreply, %{state | consecutive_failures: failures}}
    end
  end

  defp check_hub_health do
    # HTTPoison 또는 Mint로 GET 요청!
    # 200 → :ok, 그 외 → :error
  end

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end

커밋: "feat(elixir): Hub 상태 모니터링 GenServer"
```


---

## 5. Phase 2: TypeScript 완전 전환 (2주!)

### 5-1. 현재 TS 전환 상태

```
파일 분석 (.ts + .js + .legacy.js!):
  src/hub.ts ✅ + hub.js + hub.legacy.js
  lib/auth.ts ✅ + auth.js + auth.legacy.js
  lib/runtime-profiles.ts ✅ + .js + .legacy.js
  lib/sql-guard.ts ✅ + .js + .legacy.js
  lib/routes/agents.ts ✅ + .js + .legacy.js (일부!)
  lib/routes/alarm.ts ✅ + .js
  lib/routes/health.ts ✅ + .js + .legacy.js
  lib/routes/pg.ts ✅ + .js + .legacy.js
  lib/routes/secrets.ts ✅ + .js + .legacy.js
  lib/routes/services.ts ✅ + .js + .legacy.js
  lib/routes/errors.ts ✅ + .js + .legacy.js
  lib/routes/events.ts ✅ + .js + .legacy.js
  lib/routes/logs.ts ✅ + .js + .legacy.js
  lib/routes/n8n.ts ✅ + .js + .legacy.js
  lib/routes/darwin-callback.ts ✅ + .js + .legacy.js
  scripts/telegram-callback-poller.ts ✅ + .js + .legacy.js

→ .ts 파일 모두 존재! 하지만 .js + .legacy.js도 잔존!
→ esbuild 빌드가 .ts를 컴파일하지만 .legacy.js를 누락!
```

### 5-2. TS 전환 전략

```
Step 1: .legacy.js 내용을 .ts에 완전 통합!
  모든 .legacy.js 파일의 로직을 .ts에 합침!
  require('./xxx.legacy.js') 참조 제거!
  .legacy.js 파일 삭제!

Step 2: .js 파일 제거!
  .ts가 esbuild로 빌드된 .js를 dist/에 생성!
  src/ 내 .js 파일은 불필요! 삭제!

Step 3: tsx 런타임 전환!
  현재: esbuild → dist/ → node dist/hub.js
  변경: tsx bots/hub/src/hub.ts (직접 실행!)
  → 빌드 스텝 제거! 빌드 누락 문제 원천 차단!

Step 4: package.json 업데이트!
  "main": "src/hub.ts"
  "scripts": { "start": "tsx src/hub.ts" }

Step 5: launchd plist 업데이트!
  현재: node dist/ts-runtime/bots/hub/src/hub.js
  변경: tsx bots/hub/src/hub.ts (또는 npx tsx!)

Step 6: tsconfig.strict 적용!
  typecheck:strict 통과 확인!
  @ts-nocheck 제거!

커밋: "refactor(hub): TS 완전 전환 + .legacy.js 제거"
```

### 5-3. Hub TS 전환 후 파일 구조

```
bots/hub/
  src/hub.ts           ← 메인 서버 (tsx 직접 실행!)
  lib/auth.ts          ← 인증 미들웨어
  lib/runtime-profiles.ts ← 런타임 프로파일 (legacy 통합!)
  lib/sql-guard.ts     ← SQL 인젝션 방어
  lib/routes/
    agents.ts          ← 에이전트 API
    alarm.ts           ← 알람 API
    health.ts          ← 헬스 체크 3단계!
    pg.ts              ← DB 쿼리 프록시
    secrets.ts         ← 시크릿 관리
    services.ts        ← 서비스 상태
    errors.ts          ← 에러 조회
    events.ts          ← 이벤트 조회
    logs.ts            ← 로그 조회
    n8n.ts             ← n8n 웹훅
    darwin-callback.ts ← 다윈 콜백
  scripts/
    telegram-callback-poller.ts
  launchd/
    ai.hub.resource-api.plist ← tsx 경로 업데이트!
  secrets-store.json
  package.json

삭제 대상 (18개!):
  src/hub.js, src/hub.legacy.js
  lib/auth.js, lib/auth.legacy.js
  lib/runtime-profiles.js, lib/runtime-profiles.legacy.js
  lib/sql-guard.js, lib/sql-guard.legacy.js
  lib/routes/*.js, lib/routes/*.legacy.js
  scripts/*.js, scripts/*.legacy.js
```

---

## 6. 구현 순서 요약

```
⚠️ Hub는 가장 중요한 시스템! 단계별 신중 실행!

Phase 0 (즉시! 긴급!):
  Step 1: .legacy.js → .ts 통합 (MODULE_NOT_FOUND 해결!)
  Step 2: uncaughtException → process.exit(1) 제거!
  Step 3: rate limit 완화 (pg 30→120, general 100→200!)
  Step 4: Hub 재시작 + 정상 동작 확인!
  커밋: "fix(hub): 즉시 안정화 (크래시+레이트리밋)"

Phase 1 (1주!):
  Step 1: Graceful Shutdown 구현!
  Step 2: Health Check 3단계 (live/ready/startup!)
  Step 3: Connection Tracking!
  Step 4: Elixir HubMonitor GenServer!
  커밋: "feat(hub): graceful shutdown + health 3단계"

Phase 2 (2주!):
  Step 1: 모든 .legacy.js 내용 .ts 통합 + 삭제!
  Step 2: 모든 .js 파일 삭제!
  Step 3: tsx 런타임 전환!
  Step 4: launchd plist 업데이트!
  Step 5: tsconfig.strict 적용!
  커밋: "refactor(hub): TS 완전 전환"
```

---

## 7. ⚠️ 주의사항

```
1. Hub 수정은 반드시 DEV에서 검증 후 OPS 반영!
2. 수정 시 Hub 다운타임 최소화 (30초 이내!)
3. Elixir Supervisor가 Hub에 의존 → Hub 다운 시 전 팀 영향!
4. secrets-store.json 직접 수정 주의 (JSON 파싱 에러 → 크래시!)
5. rate limit 변경 시 보안 고려 (DDoS 방어!)
6. tsx 전환 시 NODE_PATH 환경변수 확인!
7. launchd plist 변경 시 unload → 수정 → load 순서!
8. Hub 정상 가동 확인: curl http://localhost:7788/hub/health
```

---

## 관련 문서

```
기존:
  bots/hub/CLAUDE.md — Hub 코덱스 가이드!
  docs/codex/CODEX_LUNA_REMODEL.md — Hub API 의존!

커뮤니티:
  Express.js 공식 — Health Checks + Graceful Shutdown!
  PM2 공식 — Graceful Shutdown 패턴!
  oneuptime — Node.js Graceful Shutdown Handler!
  http-graceful-shutdown (npm 3.1.15) — 라이브러리 참고!
  Mastering Modern Node.js 2026 — ESM + Graceful Shutdown 패턴!
```
