defmodule Darwin.V2.Cycle.Discover do
  @moduledoc "다윈 V2 Discover 사이클 GenServer — 7단계 R&D 루프의 Discover 단계."

  use GenServer
  require Logger

  alias Darwin.V2.ResearchRegistry

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.discover] Discover 단계 기동")
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
    {:reply, Map.put(state, :phase, :discover), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    Logger.debug("[darwin/cycle.discover] Discover 실행 — payload=#{inspect(payload)}")

    # 신규 논문 발견 시 Research Registry에 등록
    paper = Map.get(payload, :paper)
    if paper && Map.get(paper, :paper_id) do
      ResearchRegistry.register_paper(paper)
    end

    new_state = %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end
end
