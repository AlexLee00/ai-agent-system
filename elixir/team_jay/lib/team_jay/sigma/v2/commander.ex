defmodule Sigma.V2.Commander do
  @moduledoc """
  시그마팀 Commander v2 — Jido.AI.Agent 기반 자율 판단·조율 허브.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §4.1
  Phase 0: skeleton only — 실제 로직은 Phase 1에서 구현.

  역할:
    - Directive 생성 + Constitutional 원칙 자기평가 (sigma_principles.yaml)
    - Tier 0/1/2/3 분기 처리
    - Pod 조율 (Risk / Growth / Trend)
    - Kill Switch (SIGMA_V2_ENABLED 환경변수)
  """

  use Jido.Agent, name: "sigma_v2_commander"

  # TODO(Phase 1): mount Sigma.V2.Skill.DataQualityGuard
  # TODO(Phase 1): mount Sigma.V2.Skill.CausalCheck
  # TODO(Phase 1): mount Sigma.V2.Skill.ObservabilityPlanner
  # TODO(Phase 1): implement directive/1 — principle check + tier dispatch
  # TODO(Phase 1): implement rollback/1 — Tier 3 override rollback
end
