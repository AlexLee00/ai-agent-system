defmodule Sigma.V2.Skill.DataQualityGuard do
  @moduledoc """
  DataQualityGuard Skill — Zoi 스키마 기반 데이터 품질 검증.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.3
  보강 문서: docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md §5
  Phase 0: skeleton only.

  역할:
    - 팀별 Zoi 스키마 로드 및 데이터 유효성 검사
    - 누락값 / 이상값 / 타입 불일치 탐지
    - 품질 점수 계산 (0.0~1.0)
  """

  use Jido.Action,
    name: "sigma_v2_data_quality_guard",
    description: "Validate team data against Zoi schema before analysis",
    schema: [
      team: [type: :string, required: true],
      data: [type: :map, required: true]
    ]

  # TODO(Phase 1): implement run/2 — Zoi 스키마 로드 + 검증 로직
  # TODO(Phase 1): quality_score/1 — 0.0~1.0 점수 반환
end
