defmodule TeamJay.Investment.Risk.Nemesis do
  @moduledoc """
  투자팀 리스크 평가 GenServer 스캐폴드.

  signal 이벤트를 받아 승인 여부를 결정하는 위치를 고정한다. 현재는
  scaffold metadata만 붙여 approved_signal로 전달한다.
  """

  use GenServer

  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_risk, symbol}}}

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.signal(symbol))

    {:ok,
     %{
       symbol: symbol,
       reviewed_count: 0,
       last_review_at: nil
     }}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:signal, signal}}, state) do
    approved_signal = %{
      signal: signal,
      source: :risk_scaffold,
      approved: true,
      reviewed_at: DateTime.utc_now()
    }

    PubSub.broadcast(Topics.approved_signal(state.symbol), {:approved_signal, approved_signal})

    {:noreply,
     %{state | reviewed_count: state.reviewed_count + 1, last_review_at: approved_signal.reviewed_at}}
  end
end
