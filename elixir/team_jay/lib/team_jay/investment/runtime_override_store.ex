defmodule TeamJay.Investment.RuntimeOverrideStore do
  @moduledoc """
  Phase 5.5-4 런타임 오버라이드 저장소 스캐폴드.

  strategy_update 이벤트를 받아 ALLOW / ESCALATE 제안을 런타임 오버라이드 snapshot으로
  정리하고 broadcast 한다. 현재는 DB 대신 GenServer state에 보관하는 안전한 scaffold다.
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

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_runtime_override_store, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.strategy_updates(symbol))
    _ = ensure_table()

    {:ok,
     %{
       symbol: symbol,
       overrides: [],
       history: [],
       update_count: 0,
       last_status: :idle,
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
       update_count: state.update_count,
       last_status: state.last_status,
       last_snapshot_at: state.last_snapshot_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at,
       active_override_count: length(state.overrides),
       history_count: length(state.history),
       overrides: state.overrides
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_update, update}}, state) do
    {status, approved, overrides} = materialize(update)
    persistence = persist_overrides(state.symbol, update, status, approved, overrides)

    snapshot =
      Events.runtime_override(state.symbol,
        status: status,
        approved: approved,
        overrides: overrides,
        history_count: length(state.history) + 1,
        strategy_update: update,
        persistence: persistence_payload(persistence)
      )

    PubSub.broadcast_runtime_override(state.symbol, {:runtime_override, snapshot})

    {:noreply,
     %{
       state
       | overrides: overrides,
         history: [snapshot | state.history] |> Enum.take(20),
         update_count: state.update_count + 1,
         last_status: status,
         last_snapshot_at: snapshot.recorded_at,
         persisted_count: state.persisted_count + persistence.inserted_count,
         last_persist_status: persistence.status,
         last_persisted_at: persistence.persisted_at || state.last_persisted_at
     }}
  end

  defp materialize(%{governance_tier: :allow, proposals: proposals}) when map_size(proposals) > 0 do
    overrides =
      Enum.map(proposals, fn {key, value} ->
        %{
          param_key: key,
          override_value: value,
          reason: :auto_allow,
          created_by: :strategy_adjuster_scaffold,
          approved: true,
          valid_until: DateTime.add(DateTime.utc_now(), 6 * 60 * 60, :second)
        }
      end)

    {:applied, true, overrides}
  end

  defp materialize(%{governance_tier: :escalate, proposals: proposals}) do
    overrides =
      Enum.map(proposals, fn {key, value} ->
        %{
          param_key: key,
          override_value: value,
          reason: :approval_required,
          created_by: :strategy_adjuster_scaffold,
          approved: false,
          valid_until: nil
        }
      end)

    {:pending_approval, false, overrides}
  end

  defp materialize(_update), do: {:blocked, false, []}

  defp ensure_table do
    with {:ok, _} <-
           SQL.query(
             Repo,
             """
             CREATE TABLE IF NOT EXISTS investment.runtime_overrides (
               id BIGSERIAL PRIMARY KEY,
               symbol TEXT NOT NULL,
               source TEXT NOT NULL,
               snapshot_status TEXT NOT NULL,
               governance_tier TEXT NOT NULL,
               action TEXT NOT NULL,
               approved BOOLEAN NOT NULL DEFAULT FALSE,
               param_key TEXT NOT NULL,
               override_value JSONB NOT NULL,
               reason TEXT NOT NULL,
               created_by TEXT NOT NULL,
               valid_until TIMESTAMPTZ,
               strategy_update JSONB NOT NULL DEFAULT '{}'::jsonb,
               inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )
             """,
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS runtime_overrides_symbol_inserted_at_idx ON investment.runtime_overrides (symbol, inserted_at DESC)",
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS runtime_overrides_param_key_idx ON investment.runtime_overrides (param_key)",
             []
           ) do
      :ok
    else
      _ -> :error
    end
  end

  defp persist_overrides(_symbol, _update, status, _approved, []) do
    %{
      status: skipped_status(status),
      inserted_count: 0,
      persisted_at: nil
    }
  end

  defp persist_overrides(symbol, update, status, approved, overrides) do
    _ = ensure_table()

    inserted_count =
      Enum.reduce(overrides, 0, fn override, acc ->
        params = [
          symbol,
          stringify(Map.get(update, :source, :strategy_adjuster_scaffold)),
          stringify(status),
          stringify(Map.get(update, :governance_tier, :block)),
          stringify(Map.get(update, :action, :hold)),
          approved,
          stringify(Map.get(override, :param_key)),
          Jason.encode!(Map.get(override, :override_value)),
          stringify(Map.get(override, :reason, :unknown)),
          stringify(Map.get(override, :created_by, :strategy_adjuster_scaffold)),
          Map.get(override, :valid_until),
          Jason.encode!(update)
        ]

        case SQL.query(
               Repo,
               """
               INSERT INTO investment.runtime_overrides (
                 symbol,
                 source,
                 snapshot_status,
                 governance_tier,
                 action,
                 approved,
                 param_key,
                 override_value,
                 reason,
                 created_by,
                 valid_until,
                 strategy_update
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb)
               """,
               params
             ) do
          {:ok, _} -> acc + 1
          {:error, _reason} -> acc
        end
      end)

    %{
      status: if(inserted_count == length(overrides), do: :persisted, else: :partial_error),
      inserted_count: inserted_count,
      persisted_at: if(inserted_count > 0, do: DateTime.utc_now(), else: nil)
    }
  end

  defp persistence_payload(persistence) do
    %{
      status: persistence.status,
      inserted_count: persistence.inserted_count,
      persisted_at: persistence.persisted_at
    }
  end

  defp skipped_status(:pending_approval), do: :approval_pending
  defp skipped_status(:blocked), do: :blocked
  defp skipped_status(_status), do: :no_overrides

  defp stringify(value) when is_binary(value), do: value
  defp stringify(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify(value), do: to_string(value)
end
