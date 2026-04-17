defmodule Sigma.V2.Skill.FeaturePlanner do
  @moduledoc """
  FeaturePlanner Skill — 피처 엔지니어링 계획 및 중요도 평가.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.6
  Phase 0: skeleton only.

  역할:
    - 팀 지표에서 분석 가능한 피처 추출 계획
    - 피처 중요도 순위 제안
    - 피처 드리프트 감지 기준 정의
  """

  use Jido.Action,
    name: "sigma_v2_feature_planner",
    description: "Plan feature engineering and prioritization for team analytics",
    schema: [
      team: [type: :string, required: true],
      available_metrics: [type: {:list, :string}, required: true]
    ]

  # TODO(Phase 1): implement run/2 — 피처 계획 생성
  # TODO(Phase 1): importance_rank/1 — 피처 중요도 순위
end
