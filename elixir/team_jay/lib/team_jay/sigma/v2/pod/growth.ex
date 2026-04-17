defmodule Sigma.V2.Pod.Growth do
  @moduledoc """
  Growth Pod — dove(보수적 안정 분석가) + librarian(지식 관리 분석가).

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §4.2
  Phase 0: skeleton only.

  분석가 구성:
    - dove: 보수적 지표 분석, 안정성 우선 피드백
    - librarian: RAG 기반 과거 피드백 검색 + 패턴 학습
  """

  use Jido.Agent, name: "sigma_v2_pod_growth"

  # TODO(Phase 1): implement dove analyst agent
  # TODO(Phase 1): implement librarian analyst agent (L2 pgvector 연동)
  # TODO(Phase 1): pod_run/1 — 두 분석가 병렬 실행 후 합의
end
