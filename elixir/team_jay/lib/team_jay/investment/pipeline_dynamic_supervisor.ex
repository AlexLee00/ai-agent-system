defmodule TeamJay.Investment.PipelineDynamicSupervisor do
  @moduledoc """
  투자팀 심볼 파이프라인용 DynamicSupervisor 스캐폴드.

  현재는 application 메인 경로에 연결하지 않고, starter에서 선택적으로
  띄울 수 있는 준비 레이어로만 제공한다.
  """

  use DynamicSupervisor

  def start_link(opts \\ []) do
    DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end
end
