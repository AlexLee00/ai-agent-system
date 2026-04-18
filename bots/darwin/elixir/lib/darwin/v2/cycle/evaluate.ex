defmodule Darwin.V2.Cycle.Evaluate do
  @moduledoc "다윈 V2 Evaluate 사이클 GenServer — 7단계 R&D 루프의 Evaluate 단계."

  use GenServer
  require Logger

  alias Darwin.V2.Rag.AgenticRag
  alias Darwin.V2.ResearchRegistry

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.evaluate] Evaluate 단계 기동")
    {:ok, %{runs: 0, last_run_at: nil}}
  end

  @doc "이 단계를 즉시 실행."
  def run_now(payload \\ %{}) do
    GenServer.cast(__MODULE__, {:run, payload})
  end

  @doc "현재 상태 조회."
  def status, do: GenServer.call(__MODULE__, :status)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.put(state, :phase, :evaluate), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    Logger.debug("[darwin/cycle.evaluate] Evaluate 실행 — payload=#{inspect(payload)}")

    paper_id = Map.get(payload, :paper_id)
    query = Map.get(payload, :query, "")

    # Agentic RAG: 논문 평가 컨텍스트 조회 (kill switch로 자동 fallback)
    rag_context =
      case AgenticRag.retrieve(query, %{stage: :evaluate, paper_id: paper_id}) do
        {:ok, result} -> result
        _ -> %{}
      end

    Logger.debug("[darwin/cycle.evaluate] RAG 컨텍스트 조회 완료 — quality=#{Map.get(rag_context, :quality, 0)}")

    # Research Registry 단계 전이: discovered → evaluated
    if paper_id do
      ResearchRegistry.transition(paper_id, "evaluated", %{rag_quality: Map.get(rag_context, :quality)})
    end

    new_state = %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end
end
