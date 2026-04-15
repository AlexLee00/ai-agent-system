defmodule TeamJay.Investment.ContinuousLoopCoordinator do
  @moduledoc """
  Phase 5.5-9 완전자율 연속 루프 통합 설계용 coordinator scaffold.

  loop / condition / strategy / circuit / resource / mode 이벤트를 묶어서
  하나의 autonomous_cycle snapshot으로 요약한다.
  """

  use GenServer

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics
  alias TeamJay.Repo

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_continuous_loop_coordinator, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    ensure_table!()

    Enum.each(
      [
        Topics.loop_cycles(symbol),
        Topics.condition_checks(symbol),
        Topics.strategy_updates(symbol),
        Topics.circuit_breakers(symbol),
        Topics.resource_feedback(symbol),
        Topics.market_modes(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_loop_cycle: nil,
       last_condition: nil,
       last_strategy_update: nil,
       last_circuit_breaker: nil,
       last_resource_feedback: nil,
       last_market_mode: nil,
       cycle_count: 0,
       last_action: :hold,
       last_readiness: :partial,
       last_completed_at: nil,
       persisted_count: 0,
       last_persist_status: :idle,
       last_persisted_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       cycle_count: state.cycle_count,
       last_action: state.last_action,
       last_readiness: state.last_readiness,
       last_completed_at: state.last_completed_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:loop_cycle, loop_cycle}}, state) do
    {:noreply, maybe_publish(%{state | last_loop_cycle: loop_cycle})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:condition_check, condition}}, state) do
    {:noreply, maybe_publish(%{state | last_condition: condition})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_update, strategy_update}}, state) do
    {:noreply, maybe_publish(%{state | last_strategy_update: strategy_update})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:circuit_breaker, circuit_breaker}}, state) do
    {:noreply, maybe_publish(%{state | last_circuit_breaker: circuit_breaker})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:resource_feedback, resource_feedback}}, state) do
    {:noreply, maybe_publish(%{state | last_resource_feedback: resource_feedback})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, market_mode}}, state) do
    {:noreply, maybe_publish(%{state | last_market_mode: market_mode})}
  end

  defp maybe_publish(%{last_loop_cycle: nil} = state), do: state
  defp maybe_publish(%{last_condition: nil} = state), do: state
  defp maybe_publish(%{last_strategy_update: nil} = state), do: state
  defp maybe_publish(%{last_circuit_breaker: nil} = state), do: state
  defp maybe_publish(%{last_resource_feedback: nil} = state), do: state
  defp maybe_publish(%{last_market_mode: nil} = state), do: state

  defp maybe_publish(state) do
    {action, phase, readiness} =
      decide(
        state.last_condition,
        state.last_strategy_update,
        state.last_circuit_breaker,
        state.last_resource_feedback,
        state.last_market_mode
      )

    snapshot =
      Events.autonomous_cycle(state.symbol,
        mode: state.last_loop_cycle.mode,
        action: action,
        phase: phase,
        readiness: readiness,
        cycle_count: state.cycle_count + 1,
        loop_cycle: state.last_loop_cycle,
        condition_check: state.last_condition,
        strategy_update: state.last_strategy_update,
        circuit_breaker: state.last_circuit_breaker,
        resource_feedback: state.last_resource_feedback,
        market_mode: state.last_market_mode
      )

    {persisted_count, persist_status, persisted_at} = persist_snapshot(state.symbol, snapshot)

    PubSub.broadcast_autonomous_cycle(state.symbol, {:autonomous_cycle, snapshot})

    %{
      state
      | cycle_count: state.cycle_count + 1,
        last_action: action,
        last_readiness: readiness,
        last_completed_at: snapshot.completed_at,
        persisted_count: state.persisted_count + persisted_count,
        last_persist_status: persist_status,
        last_persisted_at: persisted_at
    }
  end

  defp decide(_condition, _strategy, %{halted: true}, _resource, _market_mode), do: {:stop, :circuit_guard, :blocked}
  defp decide(_condition, _strategy, %{paper_mode: true}, _resource, _market_mode), do: {:paper_trade, :defensive, :guarded}

  defp decide(%{action: :exit}, _strategy, _circuit, %{ready_resources: ready}, _market_mode) when ready >= 6 do
    {:exit, :manage_position, :ready}
  end

  defp decide(%{action: :hold}, %{governance_tier: :allow}, _circuit, %{ready_resources: ready}, %{mode: mode})
       when ready >= 6 and mode in [:swing, :position_trade] do
    {:adjust, :optimize, :ready}
  end

  defp decide(_condition, _strategy, _circuit, %{ready_resources: ready}, _market_mode) when ready >= 6 do
    {:hold, :observe, :ready}
  end

  defp decide(_condition, _strategy, _circuit, _resource, _market_mode), do: {:hold, :observe, :partial}

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.autonomous_cycle_events (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        mode TEXT NOT NULL,
        action TEXT NOT NULL,
        phase TEXT NOT NULL,
        readiness TEXT NOT NULL,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        loop_cycle JSONB NOT NULL DEFAULT '{}'::jsonb,
        condition_check JSONB NOT NULL DEFAULT '{}'::jsonb,
        strategy_update JSONB NOT NULL DEFAULT '{}'::jsonb,
        circuit_breaker JSONB NOT NULL DEFAULT '{}'::jsonb,
        resource_feedback JSONB NOT NULL DEFAULT '{}'::jsonb,
        market_mode JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        completed_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS autonomous_cycle_events_symbol_completed_at_idx
      ON investment.autonomous_cycle_events (symbol, completed_at DESC)
      """,
      []
    )
  end

  defp persist_snapshot(symbol, snapshot) do
    now = DateTime.utc_now()

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.autonomous_cycle_events (
             symbol,
             mode,
             action,
             phase,
             readiness,
             cycle_count,
             loop_cycle,
             condition_check,
             strategy_update,
             circuit_breaker,
             resource_feedback,
             market_mode,
             payload,
             completed_at,
             inserted_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15)
           """,
           [
             symbol,
             Atom.to_string(snapshot.mode),
             Atom.to_string(snapshot.action),
             Atom.to_string(snapshot.phase),
             Atom.to_string(snapshot.readiness),
             snapshot.cycle_count,
             Jason.encode!(json_ready(Map.get(snapshot, :loop_cycle, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :condition_check, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :strategy_update, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :circuit_breaker, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :resource_feedback, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :market_mode, %{}))),
             Jason.encode!(json_ready(snapshot)),
             snapshot.completed_at,
             now
           ]
         ) do
      {:ok, %{num_rows: num_rows}} when num_rows > 0 ->
        {num_rows, :persisted, now}

      {:ok, _result} ->
        {0, :noop, nil}

      {:error, _reason} ->
        {0, :error, nil}
    end
  end

  defp json_ready(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp json_ready(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp json_ready(%Date{} = value), do: Date.to_iso8601(value)
  defp json_ready(%Time{} = value), do: Time.to_iso8601(value)
  defp json_ready(%_{} = struct), do: struct |> Map.from_struct() |> json_ready()
  defp json_ready(map) when is_map(map), do: Map.new(map, fn {k, v} -> {json_key(k), json_ready(v)} end)
  defp json_ready(list) when is_list(list), do: Enum.map(list, &json_ready/1)
  defp json_ready(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> Enum.map(&json_ready/1)
  defp json_ready(atom) when is_atom(atom), do: Atom.to_string(atom)
  defp json_ready(pid) when is_pid(pid), do: inspect(pid)
  defp json_ready(reference) when is_reference(reference), do: inspect(reference)
  defp json_ready(function) when is_function(function), do: inspect(function)
  defp json_ready(value), do: value

  defp json_key(key) when is_atom(key), do: Atom.to_string(key)
  defp json_key(key), do: key
end
