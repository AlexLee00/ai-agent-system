defmodule Darwin.V2.Lead do
  @moduledoc """
  다윈 V2 팀장 — 7단계 자율 사이클 총 조율자 (GenServer).

  TeamJay.Darwin.TeamLead의 V2 포트. AutonomyLevel GenServer로 상태 위임.
  JayBus 이벤트 구독 + 사이클 단계 전환 제어.
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, AutonomyLevel}
  alias TeamJay.HubClient

  defstruct [
    current_phase: :idle,
    active_papers: [],
    pipeline_runs: 0
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def paper_discovered(paper) do
    GenServer.cast(__MODULE__, {:paper_discovered, paper})
  end

  def paper_evaluated(paper, score) do
    GenServer.cast(__MODULE__, {:paper_evaluated, paper, score})
  end

  def pipeline_success do
    GenServer.cast(__MODULE__, :pipeline_success)
  end

  def pipeline_failure(reason) do
    GenServer.cast(__MODULE__, {:pipeline_failure, reason})
  end

  # ---

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[darwin/lead] 다윈 팀장 V2 시작! 자율 레벨 L#{AutonomyLevel.level()}")
    {:ok, %__MODULE__{}}
  end

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Registry.register(TeamJay.JayBus, Topics.verification_passed(), [])
    Logger.debug("[darwin/lead] JayBus 이벤트 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    new_state = handle_bus_event(topic, payload, state)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_call(:get_status, _from, state) do
    autonomy = AutonomyLevel.get()
    {:reply, %{
      current_phase: state.current_phase,
      active_papers: length(state.active_papers),
      pipeline_runs: state.pipeline_runs,
      autonomy_level: autonomy.level,
      consecutive_successes: autonomy.consecutive_successes
    }, state}
  end

  @impl GenServer
  def handle_cast({:paper_discovered, paper}, state) do
    Logger.info("[darwin/lead] 논문 발견: #{paper["title"] || paper[:title] || "unknown"}")
    papers = [paper | Enum.take(state.active_papers, 49)]
    {:noreply, %{state | active_papers: papers, current_phase: :evaluate}}
  end

  def handle_cast({:paper_evaluated, paper, score}, state) do
    if score >= 7 do
      maybe_trigger_plan(paper, score)
    end
    {:noreply, %{state | current_phase: :plan}}
  end

  def handle_cast(:pipeline_success, state) do
    AutonomyLevel.record_success()
    runs = state.pipeline_runs + 1
    {:noreply, %{state | pipeline_runs: runs, current_phase: :learn}}
  end

  def handle_cast({:pipeline_failure, reason}, state) do
    Logger.warning("[darwin/lead] 파이프라인 실패: #{inspect(reason)}")
    AutonomyLevel.record_failure(reason)
    {:noreply, %{state | current_phase: :idle}}
  end

  # ---

  defp handle_bus_event(topic, payload, state) do
    cond do
      topic == Topics.paper_discovered() ->
        paper = payload[:paper] || payload
        %{state | active_papers: [paper | Enum.take(state.active_papers, 49)]}

      topic == Topics.verification_passed() ->
        %{state | current_phase: :apply}

      true ->
        state
    end
  end

  defp maybe_trigger_plan(paper, score) do
    level = AutonomyLevel.level()

    if level >= 4 do
      Logger.info("[darwin/lead] L#{level}: 자동 구현 계획 수립 (score=#{score})")
    else
      Task.start(fn ->
        HubClient.post_alarm(
          "🔬 다윈팀 고적합 논문 발견!\n제목: #{paper["title"] || "unknown"}\n적합성: #{score}/10\n→ 구현 승인 필요",
          "darwin", "darwin"
        )
      end)
    end
  end
end
