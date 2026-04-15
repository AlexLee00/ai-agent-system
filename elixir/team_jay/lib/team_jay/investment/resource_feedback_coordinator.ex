defmodule TeamJay.Investment.ResourceFeedbackCoordinator do
  @moduledoc """
  Phase 5.5-8 전체 리소스 피드백 루프 참여를 묶는 coordinator scaffold.

  feedback / runtime_override / memory / strategy_profile 이벤트를 받아
  8개 리소스의 준비 상태를 요약한 resource_feedback snapshot을 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_resource_feedback_coordinator, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

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
       last_summarized_at: nil
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
       last_summarized_at: state.last_summarized_at
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

    PubSub.broadcast_resource_feedback(state.symbol, {:resource_feedback, snapshot})

    %{
      state
      | update_count: state.update_count + 1,
        last_ready_resources: ready_resources,
        last_recommendation: recommendation,
        last_summarized_at: snapshot.summarized_at
    }
  end

  defp build_resources(state) do
    %{
      llm: %{ready: true, status: :scaffolded, rationale: :feedback_seen},
      rag: %{ready: true, status: :scaffolded, rationale: :memory_available},
      agent_memory: %{ready: state.last_memory.snapshot_count > 0, status: :tracking, rationale: :memory_snapshot},
      vectorbt: %{ready: true, status: :guard_ready, rationale: :runtime_override_seen},
      n8n: %{ready: true, status: :workflow_placeholder, rationale: :coordinator_scaffold},
      market_data: %{ready: true, status: :loop_active, rationale: :feedback_loop},
      chronos_ta: %{ready: true, status: :profile_selected, rationale: :strategy_profile},
      onchain: %{ready: true, status: :watch_enabled, rationale: :resource_loop}
    }
  end
end
