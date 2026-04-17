defmodule Sigma.V2.Memory.L2 do
  @moduledoc """
  L2 장기 메모리 — pgvector 기반 Reflexion 노트 + RAG 검색.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.2
  보강 문서: docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md §3.4
  Phase 0: skeleton only.

  역할:
    - Reflexion 노트를 임베딩(Qwen3-Embedding-0.6B, 1024차원)으로 저장
    - 유사도 검색으로 과거 학습 회상 (pgvector <-> 연산자)
    - librarian 분석가의 RAG 백엔드
  """

  use Jido.Action,
    name: "sigma_v2_memory_l2",
    description: "Store and retrieve Reflexion notes via pgvector similarity search",
    schema: [
      operation: [type: :atom, required: true],  # :store | :retrieve
      content: [type: :string, required: false],
      team: [type: :string, required: false],
      top_k: [type: :integer, default: 5]
    ]

  # TODO(Phase 1): implement run/2 — store(embed + insert) / retrieve(embed + cosine search)
  # TODO(Phase 1): embed/1 — packages/core/lib/rag.js에서 Qwen3-Embedding-0.6B 호출
  # TODO(Phase 1): DB 스키마: sigma_v2_memory (id, team, content, embedding vector(1024), inserted_at)
end
