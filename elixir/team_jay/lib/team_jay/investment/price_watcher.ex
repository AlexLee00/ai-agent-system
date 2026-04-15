defmodule TeamJay.Investment.PriceWatcher do
  @moduledoc """
  Phase 5-A 실시간 가격 감시 GenServer 스캐폴드.

  현재는 외부 WebSocket 대신 심볼별 synthetic price tick을 주기적으로 발행한다.
  향후 ccxt WebSocket 브리지로 교체될 자리를 고정한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_interval 1_000

  def start_link(opts) do
    exchange = Keyword.fetch!(opts, :exchange)
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(exchange, symbol))
  end

  def via(exchange, symbol) do
    {:via, Registry, {TeamJay.AgentRegistry, {:investment_price_watcher, exchange, symbol}}}
  end

  def status(exchange, symbol) do
    GenServer.call(via(exchange, symbol), :status)
  end

  @impl true
  def init(opts) do
    state = %{
      exchange: Keyword.fetch!(opts, :exchange),
      symbol: Keyword.fetch!(opts, :symbol),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval),
      sequence: 0,
      last_price: seed_price(Keyword.fetch!(opts, :symbol)),
      last_tick_at: nil
    }

    schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       exchange: state.exchange,
       symbol: state.symbol,
       sequence: state.sequence,
       last_price: state.last_price,
       last_tick_at: state.last_tick_at
     }, state}
  end

  @impl true
  def handle_info(:tick, state) do
    price = next_price(state.last_price, state.sequence + 1)

    tick =
      Events.price_tick(state.symbol,
        exchange: state.exchange,
        sequence: state.sequence + 1,
        price: price
      )

    PubSub.broadcast_price_tick(state.symbol, {:price_tick, tick})
    PubSub.broadcast(Topics.market_events(state.exchange), {:price_tick, tick})
    schedule_tick(state.interval_ms)

    {:noreply,
     %{
       state
       | sequence: state.sequence + 1,
         last_price: price,
         last_tick_at: tick.observed_at
     }}
  end

  defp schedule_tick(interval_ms), do: Process.send_after(self(), :tick, interval_ms)

  defp seed_price(symbol) do
    base =
      symbol
      |> String.to_charlist()
      |> Enum.sum()
      |> rem(200)

    100.0 + base
  end

  defp next_price(last_price, sequence) do
    drift =
      case rem(sequence, 6) do
        0 -> -0.9
        1 -> 0.6
        2 -> 1.2
        3 -> -0.4
        4 -> 0.8
        _ -> -0.2
      end

    Float.round(max(last_price + drift, 1.0), 4)
  end
end
