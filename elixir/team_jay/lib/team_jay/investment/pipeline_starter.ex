defmodule TeamJay.Investment.PipelineStarter do
  @moduledoc """
  투자팀 심볼 파이프라인 starter 스캐폴드.

  현재는 DynamicSupervisor가 떠 있을 때만 선택적으로 심볼 파이프라인을
  시작/정지할 수 있게 한다. 운영 메인 경로에는 아직 연결하지 않는다.
  """

  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.SymbolPipelineSupervisor

  @default_pipelines [
    %{exchange: "binance", symbol: "BTC/USDT"},
    %{exchange: "kis", symbol: "005930"},
    %{exchange: "kis_overseas", symbol: "AAPL"}
  ]

  def default_pipelines, do: @default_pipelines

  def start_pipeline(attrs) when is_map(attrs) do
    start_pipeline(Map.to_list(attrs))
  end

  def start_pipeline(opts) when is_list(opts) do
    child_spec =
      {SymbolPipelineSupervisor,
       exchange: Keyword.fetch!(opts, :exchange),
       symbol: Keyword.fetch!(opts, :symbol),
       interval_ms: Keyword.get(opts, :interval_ms, 5_000),
       circuit_release_wait_ms: Keyword.get(opts, :circuit_release_wait_ms, 30 * 60 * 1_000)}

    DynamicSupervisor.start_child(PipelineDynamicSupervisor, child_spec)
  end

  def stop_pipeline(exchange, symbol) do
    case Registry.lookup(TeamJay.AgentRegistry, {:investment_symbol_pipeline, exchange, symbol}) do
      [{pid, _meta}] -> DynamicSupervisor.terminate_child(PipelineDynamicSupervisor, pid)
      [] -> {:error, :not_found}
    end
  end

  def start_default_pipelines do
    Enum.map(@default_pipelines, &start_pipeline/1)
  end
end
