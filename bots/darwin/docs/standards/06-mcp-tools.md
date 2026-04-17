# Darwin V2 — MCP 툴 정의

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2는 MCP(Model Context Protocol) 서버를 통해 외부 시스템과 통합됩니다. Darwin 자체 MCP 서버와 외부 MCP 서버를 모두 활용합니다.

**활성화 조건**: `DARWIN_MCP_SERVER_ENABLED=true`

---

## Darwin 자체 MCP 툴

Darwin MCP 서버는 `bots/darwin/src/mcp-server.ts`에서 실행됩니다.

### `darwin.search_papers`

연구 데이터베이스에서 논문을 검색합니다.

```typescript
// 입력 스키마
{
  query: string;          // 검색 쿼리 (키워드 또는 의미론적)
  limit?: number;         // 최대 결과 수 (기본값: 10)
  min_score?: number;     // 최소 평가 점수 (0.0~1.0)
  memory_type?: string;   // 메모리 타입 필터
  tags?: string[];        // 태그 필터
}

// 출력
{
  papers: Array<{
    id: number;
    title: string;
    url: string;
    score: number;
    similarity: number;
    memory_type: string;
    tags: string[];
  }>;
  total: number;
}
```

---

### `darwin.get_status`

Darwin V2의 현재 자율성 레벨과 파이프라인 상태를 반환합니다.

```typescript
// 입력 스키마 (없음)

// 출력
{
  autonomy_level: 3 | 4 | 5;
  kill_switch_active: boolean;
  shadow_mode: boolean;
  consecutive_successes: number;
  daily_cost_usd: number;
  budget_ratio: number;
  pipeline_running: boolean;
  last_run_at: string;       // ISO 8601
  papers_discovered_today: number;
  papers_applied_total: number;
}
```

---

### `darwin.get_insights`

최근 구현된 논문의 인사이트를 반환합니다.

```typescript
// 입력 스키마
{
  limit?: number;           // 최대 결과 수 (기본값: 5)
  team?: string;            // 적용된 팀 필터
  days?: number;            // 최근 N일 이내 (기본값: 30)
}

// 출력
{
  insights: Array<{
    paper_title: string;
    paper_url: string;
    applied_to: string[];
    applied_at: string;
    impact_summary: string;
    commit_sha?: string;
  }>;
}
```

---

### `darwin.trigger_scan`

수동으로 논문 스캔을 트리거합니다. **인증 필요**.

```typescript
// 입력 스키마
{
  source?: 'arxiv' | 'semantic_scholar' | 'all';  // 기본값: 'arxiv'
  keywords?: string[];    // 추가 키워드 (선택)
  auth_token: string;     // Hub auth token 필수
}

// 출력
{
  triggered: boolean;
  run_id: string;
  estimated_duration_ms: number;
}
```

---

## 외부 MCP 서버 연동

Darwin은 다음 외부 MCP 서버를 활용합니다. 설정은 `bots/darwin/config.yaml`의 `mcp_servers` 섹션에서 관리합니다.

### `arxiv-mcp-server`

arXiv 논문 직접 검색 및 다운로드.

```yaml
# config.yaml
mcp_servers:
  arxiv:
    enabled: true
    command: "uvx arxiv-mcp-server"
    tools:
      - arxiv.search_papers
      - arxiv.get_paper
      - arxiv.download_pdf
```

---

### `paper-search-mcp`

복수 학술 데이터베이스 통합 검색.

```yaml
mcp_servers:
  paper_search:
    enabled: false   # 기본 비활성화
    command: "npx paper-search-mcp"
    tools:
      - search.cross_database
      - search.get_citations
```

---

### `semanticscholar-mcp-server`

Semantic Scholar API 경유 논문 메타데이터 및 인용 그래프.

```yaml
mcp_servers:
  semantic_scholar:
    enabled: false   # 기본 비활성화
    command: "uvx semanticscholar-mcp-server"
    tools:
      - semantic.get_paper
      - semantic.get_citations
      - semantic.get_references
      - semantic.search_papers
```

---

## MCP 서버 포트

| 서버 | 포트 | 프로토콜 |
|------|------|----------|
| Darwin MCP | 18800 | stdio / HTTP |
| arxiv-mcp-server | stdio | stdio |
| paper-search-mcp | stdio | stdio |
| semanticscholar-mcp | stdio | stdio |

---

## 인증

Darwin MCP 서버에 접근하려면 Hub auth token이 필요합니다.

```bash
# MCP 클라이언트 설정
DARWIN_MCP_AUTH_TOKEN=${HUB_AUTH_TOKEN}
```

`darwin.trigger_scan` 외 조회 툴은 읽기 전용으로 인증 불필요.
