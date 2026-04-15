defmodule TeamJay.Investment.AgentMemory do
  @moduledoc """
  Phase 5-D 에이전트 메모리 스캐폴드.

  feedback / strategy_update / runtime_override를 받아
  에피소딕 / 시맨틱 / 프로시져럴 메모리 snapshot을 고정한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

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
       last_snapshot_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       snapshot_count: state.snapshot_count,
       last_snapshot_at: state.last_snapshot_at,
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

    PubSub.broadcast_memory_snapshot(state.symbol, {:memory_snapshot, snapshot})

    %{
      state
      | snapshot_count: state.snapshot_count + 1,
        last_snapshot_at: snapshot.recorded_at
    }
  end
end
