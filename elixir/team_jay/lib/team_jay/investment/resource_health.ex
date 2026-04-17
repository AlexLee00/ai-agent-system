defmodule TeamJay.Investment.ResourceHealth do
  @moduledoc """
  Phase 5 리소스 전체 헬스체크 scaffold.

  resource_feedback / autonomous_cycle / circuit_breaker / runtime_override 이벤트를 받아
  현재 완전자율 루프가 어느 정도 준비됐는지 하나의 health snapshot으로 요약한다.
  """

  use GenServer

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics
  alias Jay.Core.Repo

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_resource_health, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    ensure_table!()

    Enum.each(
      [
        Topics.resource_feedback(symbol),
        Topics.autonomous_cycles(symbol),
        Topics.circuit_breakers(symbol),
        Topics.runtime_overrides(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_resource_feedback: nil,
       last_autonomous_cycle: nil,
       last_circuit_breaker: nil,
       last_runtime_override: nil,
       snapshot_count: 0,
       last_status: :observe,
       last_health_score: 0.0,
       last_action: :hold,
       last_measured_at: nil,
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
       snapshot_count: state.snapshot_count,
       last_status: state.last_status,
       last_health_score: state.last_health_score,
       last_action: state.last_action,
       last_measured_at: state.last_measured_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:resource_feedback, resource_feedback}}, state) do
    {:noreply, maybe_publish(%{state | last_resource_feedback: resource_feedback})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:autonomous_cycle, autonomous_cycle}}, state) do
    {:noreply, maybe_publish(%{state | last_autonomous_cycle: autonomous_cycle})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:circuit_breaker, circuit_breaker}}, state) do
    {:noreply, maybe_publish(%{state | last_circuit_breaker: circuit_breaker})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:runtime_override, runtime_override}}, state) do
    {:noreply, maybe_publish(%{state | last_runtime_override: runtime_override})}
  end

  defp maybe_publish(%{last_resource_feedback: nil} = state), do: state
  defp maybe_publish(%{last_autonomous_cycle: nil} = state), do: state
  defp maybe_publish(%{last_circuit_breaker: nil} = state), do: state
  defp maybe_publish(%{last_runtime_override: nil} = state), do: state

  defp maybe_publish(state) do
    {status, ready, score, guards, action} =
      evaluate(
        state.last_resource_feedback,
        state.last_autonomous_cycle,
        state.last_circuit_breaker,
        state.last_runtime_override
      )

    snapshot =
      Events.resource_health(state.symbol,
        status: status,
        ready: ready,
        health_score: score,
        ready_resources: state.last_resource_feedback.ready_resources,
        active_guards: guards,
        action: action,
        resource_feedback: state.last_resource_feedback,
        autonomous_cycle: state.last_autonomous_cycle,
        circuit_breaker: state.last_circuit_breaker,
        runtime_override: state.last_runtime_override
      )

    {persisted_count, persist_status, persisted_at} = persist_snapshot(state.symbol, snapshot)

    PubSub.broadcast_resource_health(state.symbol, {:resource_health, snapshot})

    %{
      state
      | snapshot_count: state.snapshot_count + 1,
        last_status: status,
        last_health_score: score,
        last_action: action,
        last_measured_at: snapshot.measured_at,
        persisted_count: state.persisted_count + persisted_count,
        last_persist_status: persist_status,
        last_persisted_at: persisted_at
    }
  end

  defp evaluate(resource_feedback, autonomous_cycle, circuit_breaker, runtime_override) do
    guards =
      []
      |> maybe_add_guard(circuit_breaker.paper_mode, :paper_mode)
      |> maybe_add_guard(circuit_breaker.halted, :halted)
      |> maybe_add_guard(runtime_override.status == :pending_approval, :approval_pending)

    ready =
      resource_feedback.ready_resources >= 6 and
        autonomous_cycle.readiness == :ready and
        runtime_override.status in [:applied, :pending_approval] and
        circuit_breaker.level in [0, 1]

    score =
      0.4 * resource_ratio(resource_feedback.ready_resources) +
        0.3 * readiness_score(autonomous_cycle.readiness) +
        0.2 * override_score(runtime_override.status) +
        0.1 * breaker_score(circuit_breaker.level)

    cond do
      circuit_breaker.halted ->
        {:blocked, false, score, guards, :stop}

      circuit_breaker.paper_mode ->
        {:guarded, false, score, guards, :paper_trade}

      ready ->
        {:ready, true, score, guards, autonomous_cycle.action}

      true ->
        {:observe, false, score, guards, :hold}
    end
  end

  defp maybe_add_guard(guards, true, guard), do: [guard | guards]
  defp maybe_add_guard(guards, _false, _guard), do: guards

  defp resource_ratio(count), do: min(count / 8.0, 1.0)
  defp readiness_score(:ready), do: 1.0
  defp readiness_score(:guarded), do: 0.5
  defp readiness_score(_), do: 0.2
  defp override_score(:applied), do: 1.0
  defp override_score(:pending_approval), do: 0.6
  defp override_score(_), do: 0.2
  defp breaker_score(0), do: 1.0
  defp breaker_score(1), do: 0.7
  defp breaker_score(2), do: 0.4
  defp breaker_score(_), do: 0.0

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.resource_health_events (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        health_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        ready_resources INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL,
        active_guards JSONB NOT NULL DEFAULT '[]'::jsonb,
        resource_feedback JSONB NOT NULL DEFAULT '{}'::jsonb,
        autonomous_cycle JSONB NOT NULL DEFAULT '{}'::jsonb,
        circuit_breaker JSONB NOT NULL DEFAULT '{}'::jsonb,
        runtime_override JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        measured_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS resource_health_events_symbol_measured_at_idx
      ON investment.resource_health_events (symbol, measured_at DESC)
      """,
      []
    )
  end

  defp persist_snapshot(symbol, snapshot) do
    now = DateTime.utc_now()

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.resource_health_events (
             symbol,
             status,
             ready,
             health_score,
             ready_resources,
             action,
             active_guards,
             resource_feedback,
             autonomous_cycle,
             circuit_breaker,
             runtime_override,
             payload,
             measured_at,
             inserted_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
           """,
           [
             symbol,
             Atom.to_string(snapshot.status),
             snapshot.ready,
             snapshot.health_score,
             snapshot.ready_resources,
             Atom.to_string(snapshot.action),
             Jason.encode!(json_ready(Map.get(snapshot, :active_guards, []))),
             Jason.encode!(json_ready(Map.get(snapshot, :resource_feedback, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :autonomous_cycle, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :circuit_breaker, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :runtime_override, %{}))),
             Jason.encode!(json_ready(snapshot)),
             snapshot.measured_at,
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
