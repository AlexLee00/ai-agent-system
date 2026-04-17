defmodule Sigma.V2.Skill.CausalCheck do
  @moduledoc """
  CausalCheck Skill — 상관관계 vs 인과관계 구분 검증.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.4
  Phase 0: skeleton only.

  역할:
    - 분석가가 제안한 피드백의 인과성 검증
    - 혼란변수(confound) 탐지
    - 인과성 신뢰도 점수 반환
  """

  use Jido.Action,
    name: "sigma_v2_causal_check",
    description: "Check causal validity of proposed feedback before application",
    schema: [
      team: [type: :string, required: true],
      hypothesis: [type: :string, required: true],
      supporting_data: [type: :map, required: true]
    ]

  # TODO(Phase 1): implement run/2 — 인과성 검증 로직
  # TODO(Phase 1): causal_score/1 — 인과성 신뢰도 0.0~1.0
end
