defmodule Darwin.V2.Cycle.Apply do
  @moduledoc "다윈 V2 Apply 사이클 GenServer — 7단계 R&D 루프의 Apply 단계."

  use GenServer
  require Logger

  alias Darwin.V2.ResearchRegistry

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.apply] Apply 단계 기동")
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
    {:reply, Map.put(state, :phase, :apply), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    Logger.debug("[darwin/cycle.apply] Apply 실행 — payload=#{inspect(payload)}")

    paper_id = Map.get(payload, :paper_id)

    if paper_id do
      # Research Registry 단계 전이: verified → applied
      ResearchRegistry.transition(paper_id, "applied", %{})

      # 구현 효과 링크 (commit_sha, target 파일 등)
      effect = Map.get(payload, :effect)
      if effect do
        ResearchRegistry.link_effect(paper_id, effect)
      end
    end

    new_state = %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end
end
