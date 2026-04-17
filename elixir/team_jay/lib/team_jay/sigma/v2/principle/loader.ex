defmodule Sigma.V2.Principle.Loader do
  @moduledoc """
  Constitutional 원칙 로더 — sigma_principles.yaml 파싱.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.7
  Phase 0: skeleton only.

  역할:
    - elixir/team_jay/config/sigma_principles.yaml 로드
    - Commander의 자기평가(self-critique) 루프에 원칙 제공
    - Kill Switch (SIGMA_V2_ENABLED=false 시 로드 건너뜀)
  """

  @principles_path Path.join(:code.priv_dir(:team_jay), "../config/sigma_principles.yaml")

  def load do
    # TODO(Phase 1): YamlElixir.read_from_file!/1 로 파싱
    # TODO(Phase 1): 원칙 구조체로 변환 후 캐싱
    {:ok, %{path: @principles_path, loaded: false, reason: "Phase 1 구현 예정"}}
  end
end
