defmodule TeamJay.Investment.Decision.Luna do
  @moduledoc """
  투자팀 최종 판단 GenServer 스캐폴드.

  분석가 이벤트를 모아 최소 신호 구조를 만든다. 현재는 분석 4종이 모두
  들어왔을 때 scaffold signal만 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Analyst.Worker, as: AnalystWorker
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_decision, symbol}}}

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.analysis(symbol))

    {:ok,
     %{
       symbol: symbol,
       analyses: %{},
       decision_count: 0,
       last_decision_at: nil
     }}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:analysis, analyst_type, analysis}}, state) do
    analyses = Map.put(state.analyses, analyst_type, analysis)

    if ready_for_decision?(analyses) do
      signal = build_signal_payload(state.symbol, analyses, state.decision_count + 1)
      PubSub.broadcast(Topics.signal(state.symbol), {:signal, signal})

      {:noreply,
       %{
         state
         | analyses: %{},
           decision_count: state.decision_count + 1,
           last_decision_at: signal.generated_at
       }}
    else
      {:noreply, %{state | analyses: analyses}}
    end
  end

  defp ready_for_decision?(analyses) do
    AnalystWorker.supported_types()
    |> Enum.all?(&Map.has_key?(analyses, &1))
  end

  defp build_signal_payload(symbol, analyses, sequence) do
    Events.signal(symbol,
      sequence: sequence,
      analyses: analyses
    )
  end
end
