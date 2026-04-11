defmodule TeamJay.Investment.Indicator.Worker do
  @moduledoc """
  투자팀 지표 계산 GenServer 스캐폴드.

  현재는 trade_events를 구독해 최소 메타데이터만 붙인 indicator 이벤트를 발행한다.
  실전 전환 때 OHLC/TA 계산을 이 모듈로 이동한다.
  """

  use GenServer

  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_indicator, symbol}}}

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.trade_events(symbol))

    {:ok,
     %{
       symbol: symbol,
       indicator_count: 0,
       last_input_at: nil
     }}
  end

  @impl true
  def handle_info({:investment_event, topic, event}, state) do
    indicator_payload = %{
      symbol: state.symbol,
      topic: topic,
      source: :indicator_scaffold,
      computed_at: DateTime.utc_now(),
      input: event
    }

    PubSub.broadcast_indicator(state.symbol, indicator_payload)

    {:noreply,
     %{state | indicator_count: state.indicator_count + 1, last_input_at: indicator_payload.computed_at}}
  end
end
