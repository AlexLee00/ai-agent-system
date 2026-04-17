# HEARTBEAT.md — 다윈팀 헬스체크

## 1. Kill Switch 상태 확인

```bash
echo "DARWIN_V2_ENABLED=$DARWIN_V2_ENABLED"
echo "DARWIN_CYCLE_ENABLED=$DARWIN_CYCLE_ENABLED"
echo "DARWIN_SHADOW_ENABLED=$DARWIN_SHADOW_ENABLED"
echo "DARWIN_L5_ENABLED=$DARWIN_L5_ENABLED"
echo "DARWIN_MCP_ENABLED=$DARWIN_MCP_ENABLED"
echo "DARWIN_ESPL_ENABLED=$DARWIN_ESPL_ENABLED"
echo "DARWIN_SELF_RAG_ENABLED=$DARWIN_SELF_RAG_ENABLED"
```

## 2. 자율 레벨 확인

```bash
cat bots/darwin/sandbox/darwin-autonomy-level.json
```

## 3. V1 TS 사이클 상태

```bash
# 마지막 스캔 결과
ls -la bots/darwin/sandbox/proposals/ | tail -5

# 실행 로그 (launchd)
tail -50 /tmp/darwin-scanner.log
```

## 4. V2 Elixir 상태 (DARWIN_V2_ENABLED=true 시)

```bash
# MCP 헬스체크 (DARWIN_HTTP_PORT 설정 시)
curl http://localhost:${DARWIN_HTTP_PORT}/mcp/tools/list

# Elixir 컴파일 + 테스트
cd bots/darwin/elixir && mix test
```

## 5. LLM 비용 현황

```sql
SELECT agent, model, SUM(cost_usd) AS total_cost
FROM darwin_llm_cost_tracking
WHERE logged_at >= NOW() - INTERVAL '1 day'
GROUP BY agent, model
ORDER BY total_cost DESC;
```

## 6. 최근 사이클 결과

```sql
SELECT paper_title, relevance_score, verification_status, completed_at
FROM darwin_cycle_results
ORDER BY completed_at DESC
LIMIT 10;
```

## 7. Shadow Mode 일치율

```sql
SELECT AVG(match_score) AS avg_match, COUNT(*) AS runs
FROM darwin_v2_shadow_runs
WHERE inserted_at >= NOW() - INTERVAL '7 days';
```
목표: 7일 평균 >= 0.95 → V2 사이클 단계적 활성화 가능.
