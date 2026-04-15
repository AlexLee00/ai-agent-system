defmodule TeamJay.Investment.PositionManager do
  @moduledoc """
  Phase 5-A 포지션 관리 GenServer 스캐폴드.

  trade_result와 price_tick을 받아 심볼별 포지션 상태를 추적하고
  position_state 이벤트를 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_position_manager, symbol}}}

  def status(symbol) do
    GenServer.call(via(symbol), :status)
  end

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.trade_result(symbol))
    {:ok, _} = PubSub.subscribe(Topics.price_ticks(symbol))

    {:ok,
     %{
       symbol: symbol,
       open?: false,
       quantity: 0.0,
       entry_price: nil,
       current_price: nil,
       pnl_pct: 0.0,
       snapshot_count: 0,
       last_snapshot_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       open?: state.open?,
       quantity: state.quantity,
       entry_price: state.entry_price,
       current_price: state.current_price,
       pnl_pct: state.pnl_pct,
       snapshot_count: state.snapshot_count,
       last_snapshot_at: state.last_snapshot_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:trade_result, result}}, state) do
    next_state =
      if state.open? do
        %{state | open?: false, quantity: 0.0, entry_price: nil, pnl_pct: 0.0}
      else
        price = state.current_price || synthetic_entry_price(state.symbol)
        %{state | open?: true, quantity: 1.0, entry_price: price, current_price: price, pnl_pct: 0.0}
      end

    {:noreply, publish_snapshot(next_state, %{trigger: :trade_result, trade_result: result})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:price_tick, tick}}, state) do
    current_price = Float.round(tick.price * 1.0, 4)

    next_state =
      state
      |> Map.put(:current_price, current_price)
      |> Map.put(:pnl_pct, compute_pnl_pct(state.entry_price, current_price, state.open?))

    {:noreply, publish_snapshot(next_state, %{trigger: :price_tick, price_tick: tick})}
  end

  defp publish_snapshot(state, attrs) do
    snapshot =
      Events.position_snapshot(state.symbol,
        status: if(state.open?, do: :open, else: :flat),
        quantity: state.quantity,
        entry_price: state.entry_price,
        current_price: state.current_price,
        pnl_pct: state.pnl_pct,
        metadata: attrs
      )

    PubSub.broadcast_position_state(state.symbol, {:position_state, snapshot})

    %{
      state
      | snapshot_count: state.snapshot_count + 1,
        last_snapshot_at: snapshot.updated_at
    }
  end

  defp synthetic_entry_price(symbol) do
    symbol
    |> String.to_charlist()
    |> Enum.sum()
    |> rem(200)
    |> Kernel.+(100)
    |> Kernel.*(1.0)
  end

  defp compute_pnl_pct(nil, _current_price, _open?), do: 0.0
  defp compute_pnl_pct(_entry_price, _current_price, false), do: 0.0

  defp compute_pnl_pct(entry_price, current_price, true)
       when is_number(entry_price) and is_number(current_price) and entry_price > 0 do
    Float.round(((current_price - entry_price) / entry_price) * 100, 4)
  end

  defp compute_pnl_pct(_, _, _), do: 0.0
end
