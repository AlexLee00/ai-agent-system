defmodule Sigma.V2.Pod.Risk do
  @moduledoc """
  Risk Pod — hawk(공격적 성장 분석가) + optimizer(비용 최적화 분석가).

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §4.2
  Phase 0: skeleton only.

  분석가 구성:
    - hawk: 공격적 성장 지표 분석, 고위험 피드백 제안
    - optimizer: 비용 효율성 분석, 리소스 최적화 제안
  """

  use Jido.Agent, name: "sigma_v2_pod_risk"

  # TODO(Phase 1): implement hawk analyst agent
  # TODO(Phase 1): implement optimizer analyst agent
  # TODO(Phase 1): pod_run/1 — 두 분석가 병렬 실행 후 합의
end
