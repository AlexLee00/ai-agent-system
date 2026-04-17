# Darwin V2 — 메모리 아키텍처

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2는 2계층 메모리 시스템을 운영합니다. L1은 세션 내 빠른 접근을 위한 캐시이고, L2는 영속적인 벡터 기반 장기 메모리입니다.

---

## L1 — ETS 세션 캐시

**저장소**: Erlang ETS (인메모리, 프로세스 생존 동안 유지)

**특징**:
- 조회 속도: O(1)
- 생존 기간: 세션(프로세스) 단위, 매일 자정 초기화
- 용도: 현재 파이프라인 실행 컨텍스트, 임시 계산 결과
- 최대 크기: 에이전트당 1,000 항목

**L1 → L2 승격 조건**:
```
importance >= 0.7 → L2(pgvector)에 영속화
importance < 0.7 → 세션 종료 시 폐기
```

---

## L2 — pgvector 장기 메모리

**저장소**: PostgreSQL `darwin_agent_memory` (1024차원 벡터)

**임베딩 모델**: Qwen3-Embedding-0.6B (로컬 MLX, 비용 $0)

**유사도 계산**: Cosine Similarity (`vector_cosine_ops`)

---

## 메모리 타입

| 타입 | 설명 | 만료 |
|------|------|------|
| `semantic` | 영구 지식 (검증된 인사이트) | 없음 |
| `episodic` | 사건 기억 (파이프라인 실행 기록) | 30일 |
| `procedural` | 절차 패턴 (AVOID 태그 포함 실패 패턴) | 없음 |
| `paper_insight` | 논문별 핵심 인사이트 | 없음 |
| `evaluation_pattern` | 논문 평가 패턴 (반복 학습) | 없음 |
| `implementation_strategy` | 구현 전략 (성공 패턴) | 없음 |
| `failure_lesson` | 실패 교훈 (Edison 오류 원인) | 없음 |
| `keyword_signal` | 키워드-성공률 상관관계 | 90일 |

---

## 메모리 쓰기 정책

Reflexion 에이전트가 파이프라인 완료 후 메모리를 평가하고 저장합니다.

```
effectiveness >= 0.3  →  memory_type = 'semantic'  (영구 보존)
0 <= effectiveness < 0.3  →  memory_type = 'episodic'  (30일 보존)
effectiveness < 0      →  memory_type = 'procedural' + tags에 'AVOID' 추가 → Reflexion 강화 트리거
```

---

## 메모리 검색

유사도 검색 (코사인):

```sql
-- 관련 메모리 상위 5개 검색
SELECT content, memory_type, importance, 1 - (embedding <=> $1) AS similarity
FROM darwin_agent_memory
WHERE team = 'darwin'
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY embedding <=> $1
LIMIT 5;
```

중요도 가중 검색:

```sql
-- 중요도 × 유사도 복합 정렬
SELECT content, memory_type, importance,
       (importance * 0.3 + (1 - (embedding <=> $1)) * 0.7) AS score
FROM darwin_agent_memory
WHERE team = 'darwin'
ORDER BY score DESC
LIMIT 10;
```

---

## 메모리 수명 관리

**자동 만료**: `expires_at < NOW()`인 레코드는 주간 배치로 삭제

**중요도 감쇠**: 에피소딕 메모리는 30일 경과 시 자동 만료

**태그 시스템**:
- `AVOID`: 반복하면 안 되는 패턴
- `HIGH_VALUE`: 높은 성과를 낸 전략
- `PENDING_REVIEW`: 마스터 검토 필요
- `ARCHIVED`: 수동으로 보관 처리

---

## pgvector 설정

```sql
-- 인덱스 설정 (50 lists, 1024차원)
CREATE INDEX idx_darwin_memory_embedding
ON darwin_agent_memory
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 50);

-- 검색 시 probe 수 설정 (정확도 vs 속도)
SET ivfflat.probes = 5;   -- 빠른 검색
SET ivfflat.probes = 10;  -- 정확한 검색
```
