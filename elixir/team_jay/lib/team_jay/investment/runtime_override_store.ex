defmodule TeamJay.Investment.RuntimeOverrideStore do
  @moduledoc """
  Phase 5.5-4 런타임 오버라이드 저장소 스캐폴드.

  strategy_update 이벤트를 받아 ALLOW / ESCALATE 제안을 런타임 오버라이드 snapshot으로
  정리하고 broadcast 한다. 현재는 DB 대신 GenServer state에 보관하는 안전한 scaffold다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

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

    {:ok,
     %{
       symbol: symbol,
       overrides: [],
       history: [],
       update_count: 0,
       last_status: :idle,
       last_snapshot_at: nil
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
       active_override_count: length(state.overrides),
       history_count: length(state.history),
       overrides: state.overrides
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_update, update}}, state) do
    {status, approved, overrides} = materialize(update)

    snapshot =
      Events.runtime_override(state.symbol,
        status: status,
        approved: approved,
        overrides: overrides,
        history_count: length(state.history) + 1,
        strategy_update: update
      )

    PubSub.broadcast_runtime_override(state.symbol, {:runtime_override, snapshot})

    {:noreply,
     %{
       state
       | overrides: overrides,
         history: [snapshot | state.history] |> Enum.take(20),
         update_count: state.update_count + 1,
         last_status: status,
         last_snapshot_at: snapshot.recorded_at
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
end
