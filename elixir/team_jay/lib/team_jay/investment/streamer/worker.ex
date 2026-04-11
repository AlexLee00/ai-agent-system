defmodule TeamJay.Investment.Streamer.Worker do
  @moduledoc """
  시장 이벤트 수집 GenServer 스캐폴드.

  현재는 외부 WebSocket 연결 대신 heartbeat 이벤트만 발행한다.
  실전 전환 때 ccxt/WS 브리지와 연결한다.
  """

  use GenServer

  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_interval 5_000

  def start_link(opts) do
    exchange = Keyword.fetch!(opts, :exchange)
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(exchange, symbol))
  end

  def via(exchange, symbol) do
    {:via, Registry, {TeamJay.AgentRegistry, {:investment_streamer, exchange, symbol}}}
  end

  @impl true
  def init(opts) do
    state = %{
      exchange: Keyword.fetch!(opts, :exchange),
      symbol: Keyword.fetch!(opts, :symbol),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval),
      last_event_at: nil
    }

    schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_info(:tick, state) do
    event = %{
      exchange: state.exchange,
      symbol: state.symbol,
      source: :streamer_scaffold,
      observed_at: DateTime.utc_now()
    }

    PubSub.broadcast(Topics.trade_events(state.symbol), event)
    PubSub.broadcast(Topics.market_events(state.exchange), event)
    schedule_tick(state.interval_ms)

    {:noreply, %{state | last_event_at: event.observed_at}}
  end

  defp schedule_tick(interval_ms), do: Process.send_after(self(), :tick, interval_ms)
end
