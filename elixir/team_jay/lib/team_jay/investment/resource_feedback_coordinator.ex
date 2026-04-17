defmodule TeamJay.Investment.ResourceFeedbackCoordinator do
  @moduledoc """
  CODEX_LUNA_AUTONOMOUS_LOOP Phase D — 8개 리소스 피드백 루프 코디네이터.

  feedback / runtime_override / memory / strategy_profile 이벤트를 받아
  8개 리소스의 실제 준비 상태를 요약한 resource_feedback snapshot을 발행한다.

  헬스체크 대상:
  - LLM: MLX OpenAI-compatible `/v1/models`
  - n8n: `/healthz`
  - market_data: price_watcher 활성 여부 (last_feedback 기반)
  - agent_memory: memory snapshot count
  - rag/vectorbt/chronos_ta/onchain: 이벤트 수신 기반 추론
  """

  use GenServer

  alias Ecto.Adapters.SQL
  alias Jay.Core.Config
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics
  alias Jay.Core.Repo

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_resource_feedback_coordinator, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    ensure_table!()

    Enum.each(
      [
        Topics.feedback(symbol),
        Topics.runtime_overrides(symbol),
        Topics.memory_snapshots(symbol),
        Topics.strategy_profiles(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_feedback: nil,
       last_override: nil,
       last_memory: nil,
       last_profile: nil,
       update_count: 0,
       last_ready_resources: 0,
       last_recommendation: :observe,
       last_summarized_at: nil,
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
       update_count: state.update_count,
       last_ready_resources: state.last_ready_resources,
       last_recommendation: state.last_recommendation,
       last_summarized_at: state.last_summarized_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:feedback, feedback}}, state) do
    {:noreply, maybe_publish(%{state | last_feedback: feedback})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:runtime_override, override}}, state) do
    {:noreply, maybe_publish(%{state | last_override: override})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:memory_snapshot, memory}}, state) do
    {:noreply, maybe_publish(%{state | last_memory: memory})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_profile, profile}}, state) do
    {:noreply, maybe_publish(%{state | last_profile: profile})}
  end

  defp maybe_publish(%{last_feedback: nil} = state), do: state
  defp maybe_publish(%{last_override: nil} = state), do: state
  defp maybe_publish(%{last_memory: nil} = state), do: state
  defp maybe_publish(%{last_profile: nil} = state), do: state

  defp maybe_publish(state) do
    resources = build_resources(state)
    ready_resources = Enum.count(resources, fn {_name, meta} -> meta.ready end)
    recommendation = if ready_resources >= 6, do: :planner_ready, else: :observe

    snapshot =
      Events.resource_feedback(state.symbol,
        ready_resources: ready_resources,
        resources: resources,
        recommendation: recommendation,
        feedback: state.last_feedback,
        runtime_override: state.last_override,
        memory_snapshot: state.last_memory,
        strategy_profile: state.last_profile
      )

    {persisted_count, persist_status, persisted_at} = persist_snapshot(state.symbol, snapshot)

    PubSub.broadcast_resource_feedback(state.symbol, {:resource_feedback, snapshot})

    %{
      state
      | update_count: state.update_count + 1,
        last_ready_resources: ready_resources,
        last_recommendation: recommendation,
        last_summarized_at: snapshot.summarized_at,
        persisted_count: state.persisted_count + persisted_count,
        last_persist_status: persist_status,
        last_persisted_at: persisted_at
    }
  end

  defp build_resources(state) do
    llm_ready = ping_http("#{Config.local_llm_base_url()}/v1/models", 2_000)
    n8n_ready = ping_http("#{Config.n8n_base_url()}/healthz", 2_000)

    memory_count = get_in(state, [:last_memory, :snapshot_count]) || 0
    override_present = not is_nil(state.last_override)
    profile_present = not is_nil(state.last_profile)
    feedback_present = not is_nil(state.last_feedback)

    %{
      llm:          %{ready: llm_ready, status: if(llm_ready, do: :online, else: :offline), rationale: :http_ping},
      rag:          %{ready: override_present, status: if(override_present, do: :active, else: :idle), rationale: :runtime_override_seen},
      agent_memory: %{ready: memory_count > 0, status: if(memory_count > 0, do: :tracking, else: :empty), rationale: :memory_snapshot_count},
      vectorbt:     %{ready: override_present, status: :guard_ready, rationale: :override_guard},
      n8n:          %{ready: n8n_ready, status: if(n8n_ready, do: :online, else: :offline), rationale: :http_ping},
      market_data:  %{ready: feedback_present, status: if(feedback_present, do: :active, else: :idle), rationale: :feedback_loop},
      chronos_ta:   %{ready: profile_present, status: if(profile_present, do: :profile_selected, else: :no_profile), rationale: :strategy_profile},
      onchain:      %{ready: true, status: :watch_enabled, rationale: :passive_watch}
    }
  end

  # HTTP ping (sync, 타임아웃 제한)
  defp ping_http(url, timeout_ms) do
    case :httpc.request(:get, {String.to_charlist(url), []}, [{:timeout, timeout_ms}], []) do
      {:ok, {{_, status, _}, _, _}} when status in 200..299 -> true
      _ -> false
    end
  rescue
    _ -> false
  catch
    _, _ -> false
  end

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.resource_feedback_events (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        ready_resources INTEGER NOT NULL DEFAULT 0,
        recommendation TEXT NOT NULL,
        resources JSONB NOT NULL DEFAULT '{}'::jsonb,
        feedback JSONB NOT NULL DEFAULT '{}'::jsonb,
        runtime_override JSONB NOT NULL DEFAULT '{}'::jsonb,
        memory_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        strategy_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        summarized_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS resource_feedback_events_symbol_summarized_at_idx
      ON investment.resource_feedback_events (symbol, summarized_at DESC)
      """,
      []
    )
  end

  defp persist_snapshot(symbol, snapshot) do
    now = DateTime.utc_now()

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.resource_feedback_events (
             symbol,
             ready_resources,
             recommendation,
             resources,
             feedback,
             runtime_override,
             memory_snapshot,
             strategy_profile,
             payload,
             summarized_at,
             inserted_at
           )
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
           """,
           [
             symbol,
             snapshot.ready_resources,
             Atom.to_string(snapshot.recommendation),
             Jason.encode!(json_ready(snapshot.resources)),
             Jason.encode!(json_ready(Map.get(snapshot, :feedback, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :runtime_override, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :memory_snapshot, %{}))),
             Jason.encode!(json_ready(Map.get(snapshot, :strategy_profile, %{}))),
             Jason.encode!(json_ready(snapshot)),
             snapshot.summarized_at,
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
