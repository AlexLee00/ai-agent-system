defmodule Sigma.V2.Skill.ExperimentDesign do
  @moduledoc """
  ExperimentDesign Skill — A/B 실험 설계 및 통계적 유의성 계획.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.5
  Phase 0: skeleton only.

  역할:
    - 피드백 적용 전 A/B 실험 설계 제안
    - 필요 샘플 사이즈 계산
    - 실험 기간 및 성공 지표 정의
  """

  use Jido.Action,
    name: "sigma_v2_experiment_design",
    description: "Design A/B experiments for proposed feedback validation",
    schema: [
      team: [type: :string, required: true],
      change_description: [type: :string, required: true],
      target_metric: [type: :string, required: true]
    ]

  # TODO(Phase 1): implement run/2 — 실험 설계 생성 로직
  # TODO(Phase 1): sample_size/2 — 통계적 유의성 기반 샘플 사이즈
end
