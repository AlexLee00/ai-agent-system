defmodule Sigma.V2.Skill.ObservabilityPlanner do
  @moduledoc """
  ObservabilityPlanner Skill — OpenTelemetry 기반 관찰 가능성 계획.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.8
  보강 문서: docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md §5
  Phase 0: skeleton only.

  역할:
    - Directive 실행 추적 스팬 계획
    - 메트릭 수집 포인트 정의
    - 알림 임계값 설계
  """

  use Jido.Action,
    name: "sigma_v2_observability_planner",
    description: "Plan OTel spans, metrics, and alert thresholds for sigma directives",
    schema: [
      directive_type: [type: :string, required: true],
      team: [type: :string, required: true]
    ]

  # TODO(Phase 1): implement run/2 — OTel 계획 생성
  # TODO(Phase 1): span_spec/1 — 추적 스팬 명세 반환
end
