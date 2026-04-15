defmodule TeamJay.Investment.SelfReflection do
  @moduledoc """
  Phase 5-D 자기 성찰 스캐폴드.

  memory snapshot을 받아 현재 패턴에서 추천 전략을 요약하는 reflection 이벤트를 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_self_reflection, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.memory_snapshots(symbol))

    {:ok,
     %{
       symbol: symbol,
       reflection_count: 0,
       last_status: :idle,
       last_strategy: :hold,
       last_reflected_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       reflection_count: state.reflection_count,
       last_status: state.last_status,
       last_strategy: state.last_strategy,
       last_reflected_at: state.last_reflected_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:memory_snapshot, snapshot}}, state) do
    {status, insight, confidence, strategy} = reflect(snapshot)

    reflection =
      Events.reflection(state.symbol,
        status: status,
        insight: insight,
        confidence: confidence,
        recommended_strategy: strategy,
        memory_snapshot: snapshot
      )

    PubSub.broadcast_reflection(state.symbol, {:reflection, reflection})

    {:noreply,
     %{
       state
       | reflection_count: state.reflection_count + 1,
         last_status: status,
         last_strategy: strategy,
         last_reflected_at: reflection.reflected_at
     }}
  end

  defp reflect(%{procedural: [%{status: :applied} | _]}) do
    {:ready, "applied override pattern looks reusable", 0.7, :scale_allow_pattern}
  end

  defp reflect(%{semantic: [%{governance_tier: :escalate} | _]}) do
    {:observe, "approval boundary still active", 0.45, :wait_master_review}
  end

  defp reflect(%{episodic: [%{action: :execution} | _]}) do
    {:observe, "execution feedback gathered, keep current strategy", 0.35, :hold}
  end

  defp reflect(_snapshot) do
    {:observed, "pattern not stable yet", 0.2, :hold}
  end
end
