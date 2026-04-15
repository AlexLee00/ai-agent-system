defmodule TeamJay.Investment.SymbolPipelineSupervisor do
  @moduledoc """
  심볼 단위 투자 파이프라인 Supervisor 스캐폴드.

  현재는 Phase 1 준비 단계로, 단일 symbol에 대해
  Streamer -> Indicator -> Analyst -> Decision -> Risk -> Execution
  worker 묶음을 구성하는 책임만 가진다.

  아직 application 메인 경로에는 연결하지 않는다.
  """

  use Supervisor

  alias TeamJay.Investment.Analyst.Worker, as: AnalystWorker
  alias TeamJay.Investment.Decision.Luna, as: DecisionWorker
  alias TeamJay.Investment.Execution.Worker, as: ExecutionWorker
  alias TeamJay.Investment.Feedback.Realtime, as: RealtimeFeedbackWorker
  alias TeamJay.Investment.Indicator.Worker, as: IndicatorWorker
  alias TeamJay.Investment.ConditionChecker
  alias TeamJay.Investment.PositionManager
  alias TeamJay.Investment.PriceWatcher
  alias TeamJay.Investment.Risk.Nemesis, as: RiskWorker
  alias TeamJay.Investment.Streamer.Worker, as: StreamerWorker

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    exchange = Keyword.fetch!(opts, :exchange)
    Supervisor.start_link(__MODULE__, opts, name: via(exchange, symbol))
  end

  def via(exchange, symbol) do
    {:via, Registry, {TeamJay.AgentRegistry, {:investment_symbol_pipeline, exchange, symbol}}}
  end

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    exchange = Keyword.fetch!(opts, :exchange)
    interval_ms = Keyword.get(opts, :interval_ms, 5_000)

    children = [
      {StreamerWorker, exchange: exchange, symbol: symbol, interval_ms: interval_ms},
      {PriceWatcher, exchange: exchange, symbol: symbol, interval_ms: interval_ms},
      {IndicatorWorker, symbol: symbol},
      {DecisionWorker, symbol: symbol},
      {RiskWorker, symbol: symbol},
      {ExecutionWorker, symbol: symbol},
      {PositionManager, symbol: symbol},
      {ConditionChecker, symbol: symbol},
      {RealtimeFeedbackWorker, symbol: symbol}
    ] ++ analyst_children(symbol)

    Supervisor.init(children, strategy: :one_for_one)
  end

  def child_spec(opts) do
    %{
      id: {__MODULE__, {Keyword.fetch!(opts, :exchange), Keyword.fetch!(opts, :symbol)}},
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor,
      restart: :transient
    }
  end

  defp analyst_children(symbol) do
    Enum.map(AnalystWorker.supported_types(), fn analyst_type ->
      Supervisor.child_spec(
        {AnalystWorker, analyst_type: analyst_type, symbol: symbol},
        id: {AnalystWorker, analyst_type, symbol}
      )
    end)
  end
end
