defmodule TeamJay.Investment.SelfReflection do
  @moduledoc """
  Phase 5-D 자기 성찰 스캐폴드.

  memory snapshot을 받아 현재 패턴에서 추천 전략을 요약하는 reflection 이벤트를 발행한다.
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
       last_reflected_at: nil,
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
       reflection_count: state.reflection_count,
       last_status: state.last_status,
       last_strategy: state.last_strategy,
       last_reflected_at: state.last_reflected_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
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

    persistence = persist_reflection(state.symbol, reflection)

    PubSub.broadcast_reflection(state.symbol, {:reflection, reflection})

    {:noreply,
     %{
       state
       | reflection_count: state.reflection_count + 1,
         last_status: status,
         last_strategy: strategy,
         last_reflected_at: reflection.reflected_at,
         persisted_count: state.persisted_count + persistence.inserted_count,
         last_persist_status: persistence.status,
         last_persisted_at: persistence.persisted_at || state.last_persisted_at
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

  defp persist_reflection(symbol, reflection) do
    _ = ensure_table()

    params = [
      symbol,
      to_string(reflection.status),
      reflection.insight,
      reflection.confidence,
      to_string(reflection.recommended_strategy),
      Jason.encode!(Map.get(reflection, :memory_snapshot, %{})),
      reflection.reflected_at
    ]

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.reflections (
             symbol,
             status,
             insight,
             confidence,
             recommended_strategy,
             memory_snapshot,
             reflected_at
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           """,
           params
         ) do
      {:ok, _} ->
        %{status: :persisted, inserted_count: 1, persisted_at: reflection.reflected_at}

      {:error, _reason} ->
        %{status: :persist_error, inserted_count: 0, persisted_at: nil}
    end
  end

  defp ensure_table do
    with {:ok, _} <-
           SQL.query(
             Repo,
             """
             CREATE TABLE IF NOT EXISTS investment.reflections (
               id BIGSERIAL PRIMARY KEY,
               symbol TEXT NOT NULL,
               status TEXT NOT NULL,
               insight TEXT NOT NULL,
               confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0,
               recommended_strategy TEXT NOT NULL,
               memory_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
               reflected_at TIMESTAMPTZ NOT NULL,
               inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )
             """,
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS reflections_symbol_reflected_at_idx ON investment.reflections (symbol, reflected_at DESC)",
             []
           ) do
      :ok
    else
      _ -> :error
    end
  end
end
