defmodule Sigma.V2.Pod.Trend do
  @moduledoc """
  Trend Pod — owl(장기 트렌드 분석가) + forecaster(예측 분석가).

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §4.2
  Phase 0: skeleton only.

  분석가 구성:
    - owl: 장기 트렌드 패턴 감지, 거시 흐름 분석
    - forecaster: 시계열 예측, 이상 탐지
  """

  use Jido.Agent, name: "sigma_v2_pod_trend"

  # TODO(Phase 1): implement owl analyst agent
  # TODO(Phase 1): implement forecaster analyst agent
  # TODO(Phase 1): pod_run/1 — 두 분석가 병렬 실행 후 합의
end
