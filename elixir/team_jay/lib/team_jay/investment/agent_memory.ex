defmodule TeamJay.Investment.AgentMemory do
  @moduledoc """
  Phase 5-D 에이전트 메모리 스캐폴드.

  feedback / strategy_update / runtime_override를 받아
  에피소딕 / 시맨틱 / 프로시져럴 메모리 snapshot을 고정한다.
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

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_agent_memory, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [Topics.feedback(symbol), Topics.strategy_updates(symbol), Topics.runtime_overrides(symbol)],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       episodic: [],
       semantic: [],
       procedural: [],
       snapshot_count: 0,
       last_snapshot_at: nil,
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
       last_snapshot_at: state.last_snapshot_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at,
       episodic_count: length(state.episodic),
       semantic_count: length(state.semantic),
       procedural_count: length(state.procedural)
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:feedback, feedback}}, state) do
    next_state =
      update_state(state, %{
        episodic: %{
          kind: :feedback,
          action: feedback.action,
          evaluation: feedback.evaluation.status,
          captured_at: feedback.generated_at
        }
      })

    {:noreply, publish_snapshot(next_state)}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_update, update}}, state) do
    next_state =
      update_state(state, %{
        semantic: %{
          kind: :strategy_update,
          governance_tier: update.governance_tier,
          reason: update.reason,
          captured_at: update.updated_at
        }
      })

    {:noreply, publish_snapshot(next_state)}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:runtime_override, override}}, state) do
    next_state =
      update_state(state, %{
        procedural: %{
          kind: :runtime_override,
          status: override.status,
          approved: override.approved,
          override_count: length(override.overrides),
          captured_at: override.recorded_at
        }
      })

    {:noreply, publish_snapshot(next_state)}
  end

  defp update_state(state, attrs) do
    episodic = prepend_limit(Map.get(attrs, :episodic), state.episodic)
    semantic = prepend_limit(Map.get(attrs, :semantic), state.semantic)
    procedural = prepend_limit(Map.get(attrs, :procedural), state.procedural)

    %{state | episodic: episodic, semantic: semantic, procedural: procedural}
  end

  defp prepend_limit(nil, items), do: items
  defp prepend_limit(item, items), do: [item | items] |> Enum.take(10)

  defp publish_snapshot(state) do
    snapshot =
      Events.memory_snapshot(state.symbol,
        episodic: state.episodic,
        semantic: state.semantic,
        procedural: state.procedural,
        snapshot_count: state.snapshot_count + 1
      )

    persistence = persist_snapshot(state.symbol, snapshot)

    PubSub.broadcast_memory_snapshot(state.symbol, {:memory_snapshot, snapshot})

    %{
      state
      | snapshot_count: state.snapshot_count + 1,
        last_snapshot_at: snapshot.recorded_at,
        persisted_count: state.persisted_count + persistence.inserted_count,
        last_persist_status: persistence.status,
        last_persisted_at: persistence.persisted_at || state.last_persisted_at
    }
  end

  defp persist_snapshot(symbol, snapshot) do
    _ = ensure_table()

    params = [
      symbol,
      Jason.encode!(snapshot.episodic),
      Jason.encode!(snapshot.semantic),
      Jason.encode!(snapshot.procedural),
      snapshot.snapshot_count,
      snapshot.recorded_at
    ]

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.agent_memory_snapshots (
             symbol,
             episodic,
             semantic,
             procedural,
             snapshot_count,
             recorded_at
           )
           VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6)
           """,
           params
         ) do
      {:ok, _} ->
        %{status: :persisted, inserted_count: 1, persisted_at: snapshot.recorded_at}

      {:error, _reason} ->
        %{status: :persist_error, inserted_count: 0, persisted_at: nil}
    end
  end

  defp ensure_table do
    with {:ok, _} <-
           SQL.query(
             Repo,
             """
             CREATE TABLE IF NOT EXISTS investment.agent_memory_snapshots (
               id BIGSERIAL PRIMARY KEY,
               symbol TEXT NOT NULL,
               episodic JSONB NOT NULL DEFAULT '[]'::jsonb,
               semantic JSONB NOT NULL DEFAULT '[]'::jsonb,
               procedural JSONB NOT NULL DEFAULT '[]'::jsonb,
               snapshot_count INTEGER NOT NULL DEFAULT 0,
               recorded_at TIMESTAMPTZ NOT NULL,
               inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )
             """,
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS agent_memory_snapshots_symbol_recorded_at_idx ON investment.agent_memory_snapshots (symbol, recorded_at DESC)",
             []
           ) do
      :ok
    else
      _ -> :error
    end
  end
end
