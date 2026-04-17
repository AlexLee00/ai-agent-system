defmodule Sigma.V2.Memory.L1 do
  @moduledoc """
  L1 세션 메모리 — ETS 기반 단기 컨텍스트 저장.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.1
  Phase 0: skeleton only.

  역할:
    - 현재 runDaily() 세션 내 분석 컨텍스트 캐싱
    - Reflexion 노트 임시 보관
    - 세션 종료 시 L2(pgvector)로 중요 항목 승격
  """

  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    # TODO(Phase 1): ETS 테이블 생성 + 세션 컨텍스트 초기화
    {:ok, %{}}
  end

  # TODO(Phase 1): put/2, get/1, flush_to_l2/0 구현
end
