# HEARTBEAT.md — 시그마팀 헬스체크

시그마팀의 생존 신호와 Kill Switch 확인 프로토콜.

## 1. 헬스체크 엔드포인트

```bash
# Elixir v2 HTTP 라우터 (Phase 5 추가)
curl http://localhost:4010/sigma/v2/health
# 기대 응답: {"status":"ok","enabled":true|false,"last_run":"..."}

# TS v1 (Phase 5 이전 호환)
tsx bots/sigma/ts/src/sigma-daily.ts --health
```

## 2. Kill Switch 상태 확인

```bash
# 환경변수 5개
echo "SIGMA_V2_ENABLED=$SIGMA_V2_ENABLED"              # 전체 on/off
echo "SIGMA_TIER2_AUTO_APPLY=$SIGMA_TIER2_AUTO_APPLY"  # Tier 2 자동 적용
echo "SIGMA_GEPA_ENABLED=$SIGMA_GEPA_ENABLED"          # ESPL 진화 엔진
echo "SIGMA_MCP_SERVER_ENABLED=$SIGMA_MCP_SERVER_ENABLED"  # MCP 서버
echo "SIGMA_SELF_RAG_ENABLED=$SIGMA_SELF_RAG_ENABLED"  # Self-RAG
```

## 3. launchd 상태

```bash
# OPS(Mac Studio)에서
launchctl list | grep sigma
# 기대 출력: - 0 ai.sigma.daily (실행 준비 + exit 0 이력)

# 로그 확인
tail -50 /tmp/sigma-daily.log
tail -50 /tmp/sigma-daily.err.log
```

## 4. 일일 실행 로그 (baseline)

```bash
# 최근 baseline
ls -lht /tmp/sigma-baseline-*.json | head -5

# 내용 검증
cat /tmp/sigma-baseline-$(date +%Y-%m-%d).json | jq '.ok, .targetTeams, .feedbackCount'
# 기대: true / [팀 배열] / >0
```

## 5. Shadow Mode 일치율

```bash
# Shadow run 결과
cd elixir/team_jay
mix run -e "Sigma.V2.ShadowRunner.run_once() |> IO.inspect"
mix run -e "Sigma.V2.ShadowCompare.recent_match_rate() |> IO.inspect"
# 기대: match_rate >= 0.85 (85% 일치)
```

## 6. OTel 파일 exporter

```bash
# 관측성 이벤트
tail -20 /tmp/sigma_otel.jsonl | jq .
# 기대: span 이벤트 + agent/action 태그 정상
```

## 7. DB 테이블 상태

```sql
-- PostgreSQL 접속 후
SELECT COUNT(*) FROM sigma_v2_directive_audit WHERE executed_at > NOW() - INTERVAL '24 hours';
SELECT COUNT(*) FROM sigma_v2_shadow_runs WHERE created_at > NOW() - INTERVAL '24 hours';
SELECT COUNT(*) FROM sigma.agent_memory WHERE created_at > NOW() - INTERVAL '7 days';
```

## 8. 이상 신호 → 조치

| 증상 | 원인 후보 | 조치 |
|------|-----------|------|
| `/sigma/v2/health` 응답 없음 | HTTP 라우터 미기동 또는 포트 오인 | supervisor.ex + SIGMA_HTTP_PORT 확인 |
| baseline `ok: false` | TS runDaily 실패 | log 확인 후 Kill Switch off |
| Shadow match_rate < 0.7 | v2 로직 drift | Phase 1 commander.ex 회귀 검토 |
| `directive_audit` 0 rows | Commander 미호출 | `SIGMA_V2_ENABLED` 확인 |
| launchd `- 78` | exit code 78 | err 로그 + mix compile 재확인 |

## 9. 긴급 차단 절차 (30초)

```bash
# 1. launchd 중단
launchctl unload ~/Library/LaunchAgents/ai.sigma.daily.plist

# 2. 환경변수 off
echo "SIGMA_V2_ENABLED=false" >> ~/.zprofile
source ~/.zprofile

# 3. 최근 Directive 자동 적용 롤백 (Tier 2)
cd elixir/team_jay
mix run -e "Sigma.V2.RollbackScheduler.rollback_last(hours: 1)"

# 4. 슬랙/텔레그램 알림
curl -X POST "$WEBHOOK_URL" -d '{"text":"🚨 시그마 긴급 차단 실행"}'
```

## 10. 정기 점검 주기

- **매일 21:30**: launchd `ai.sigma.daily` 자동 실행 → baseline JSON
- **매주 일요일 22:00**: ESPL 진화 (Phase 4, `SIGMA_GEPA_ENABLED=true` 시)
- **매월 첫째 주**: 원칙 YAML 드리프트 점검 (`docs/DESIGN_PRINCIPLES.yaml.example` diff)

---

**참조**: `launchd/ai.sigma.daily.plist`, `SOUL.md` 원칙 7 (관측성)
