defmodule TeamJay.Investment.TradingLoop do
  @moduledoc """
  Phase 5-B 유기적 연속 루프 오케스트레이터 스캐폴드.

  signal -> approved_signal -> trade_result -> position_state -> condition_check -> feedback
  흐름을 묶어 Mode 1/2/3 전환과 cycle_complete 이벤트를 고정한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_stages [:collect, :analyze, :evaluate, :decide, :execute, :feedback]

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_trading_loop, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [
        Topics.signal(symbol),
        Topics.approved_signal(symbol),
        Topics.trade_result(symbol),
        Topics.position_state(symbol),
        Topics.condition_checks(symbol),
        Topics.feedback(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       current_mode: :mode1_explore,
       cycle_count: 0,
       last_cycle_at: nil,
       last_stage: nil,
       position_open?: false,
       pending_cycle: %{}
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       current_mode: state.current_mode,
       cycle_count: state.cycle_count,
       last_cycle_at: state.last_cycle_at,
       last_stage: state.last_stage,
       position_open?: state.position_open?,
       completed_stages: Map.keys(state.pending_cycle)
     }, state}
  end

  @impl true
  def handle_info({:investment_event, topic, payload}, state) do
    stage = stage_from_topic(state.symbol, topic)
    pending_cycle = Map.put(state.pending_cycle, stage, payload)
    next_mode = next_mode(state.current_mode, stage, payload, state.position_open?)
    position_open? = position_open?(state.position_open?, stage, payload)

    next_state = %{
      state
      | current_mode: next_mode,
        last_stage: stage,
        position_open?: position_open?,
        pending_cycle: pending_cycle
    }

    if cycle_complete?(pending_cycle) do
      cycle =
        Events.loop_cycle(state.symbol,
          mode: next_mode,
          cycle_count: state.cycle_count + 1,
          position_open?: position_open?,
          details: Map.take(pending_cycle, @default_stages)
        )

      PubSub.broadcast(Topics.loop_cycles(state.symbol), {:loop_cycle, cycle})

      {:noreply,
       %{
         next_state
         | cycle_count: state.cycle_count + 1,
           last_cycle_at: cycle.completed_at,
           pending_cycle: %{}
       }}
    else
      {:noreply, next_state}
    end
  end

  defp stage_from_topic(symbol, topic) do
    cond do
      topic == Topics.signal(symbol) -> :analyze
      topic == Topics.approved_signal(symbol) -> :decide
      topic == Topics.trade_result(symbol) -> :execute
      topic == Topics.position_state(symbol) -> :evaluate
      topic == Topics.condition_checks(symbol) -> :decide
      topic == Topics.feedback(symbol) -> :feedback
      true -> :collect
    end
  end

  defp next_mode(_current_mode, :feedback, _payload, true), do: :mode3_manage
  defp next_mode(_current_mode, :feedback, _payload, false), do: :mode1_explore
  defp next_mode(_current_mode, :analyze, _payload, false), do: :mode2_analyze
  defp next_mode(current_mode, :execute, _payload, _open?), do: current_mode
  defp next_mode(_current_mode, _stage, _payload, true), do: :mode3_manage
  defp next_mode(current_mode, _stage, _payload, false), do: current_mode

  defp position_open?(_current_open?, :evaluate, {:position_state, %{status: :open}}), do: true
  defp position_open?(_current_open?, :evaluate, {:position_state, %{status: :flat}}), do: false
  defp position_open?(current_open?, _stage, _payload), do: current_open?

  defp cycle_complete?(pending_cycle) do
    Enum.all?([:analyze, :execute, :evaluate, :feedback], &Map.has_key?(pending_cycle, &1))
  end
end
