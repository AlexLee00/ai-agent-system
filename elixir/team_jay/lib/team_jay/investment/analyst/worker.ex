defmodule TeamJay.Investment.Analyst.Worker do
  @moduledoc """
  투자팀 분석가 GenServer 스캐폴드.

  현재는 indicator 이벤트를 받아 analyst 타입별 analysis 이벤트를 발행하는
  얇은 골격만 제공한다. 실제 LLM 호출은 Phase 1 후반에 PortAgent 또는
  Elixir 네이티브 호출 경로로 연결한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @supported_types [:aria, :sophia, :oracle, :hermes]

  def start_link(opts) do
    analyst_type = Keyword.fetch!(opts, :analyst_type)
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(analyst_type, symbol))
  end

  def via(analyst_type, symbol) do
    {:via, Registry, {TeamJay.AgentRegistry, {:investment_analyst, analyst_type, symbol}}}
  end

  def supported_types, do: @supported_types

  @impl true
  def init(opts) do
    analyst_type = Keyword.fetch!(opts, :analyst_type)
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.indicators(symbol))

    {:ok,
     %{
       analyst_type: analyst_type,
       symbol: symbol,
       analysis_count: 0,
       last_analysis_at: nil
     }}
  end

  @impl true
  def handle_info({:investment_event, topic, indicator_payload}, state) do
    analysis =
      build_analysis_payload(
        state.analyst_type,
        state.symbol,
        topic,
        indicator_payload,
        state.analysis_count + 1
      )

    PubSub.broadcast(Topics.analysis(state.symbol), {:analysis, state.analyst_type, analysis})

    {:noreply,
     %{state | analysis_count: state.analysis_count + 1, last_analysis_at: analysis.generated_at}}
  end

  defp build_analysis_payload(analyst_type, symbol, topic, indicator_payload, sequence) do
    Events.analysis(symbol, analyst_type,
      topic: topic,
      sequence: sequence,
      summary: "#{analyst_type} scaffold analysis",
      input: indicator_payload
    )
  end
end
