defmodule TeamJay.Darwin.TeamLead do
  @moduledoc """
  다윈 팀장 — 7단계 연구 루프 오케스트레이터

  7단계 무한 사이클:
  DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN

  자율 레벨 (autonomy-level.ts 기반):
  - L3: 현재 (에러 강등 상태, 구현 전 승인 필요)
  - L4: 연속 5회 성공 + 7일 경과 → 자동 승격
  - L5: 완전 자율 (마스터 승인 불필요)
  """

  use GenServer
  require Logger

  alias TeamJay.HubClient
  alias TeamJay.Darwin.Topics

  @autonomy_file "bots/darwin/sandbox/darwin-autonomy-level.json"

  defstruct [
    autonomy_level: 3,       # L3 시작
    consecutive_successes: 0,
    applied_successes: 0,    # 적용 성공 횟수 (L4→L5 조건)
    last_success_at: nil,
    current_phase: :idle,    # :idle | :discover | :evaluate | :plan | :implement | :verify | :apply | :learn
    active_papers: [],       # 평가 대기 논문
    pipeline_runs: 0,
    level_upgraded_at: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ── Public API ──────────────────────────────────────────────────────

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

  def record_application_success do
    GenServer.cast(__MODULE__, :application_success)
  end

  def pipeline_failure(reason) do
    GenServer.cast(__MODULE__, {:pipeline_failure, reason})
  end

  def get_autonomy_level do
    GenServer.call(__MODULE__, :get_autonomy_level)
  end

  # ── GenServer ───────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    state = load_autonomy_state()
    Logger.info("[DarwinLead] 다윈 팀장 시작! 자율 레벨 L#{state.autonomy_level}")

    # EventLake 구독 (논문 발견 이벤트)
    Process.send_after(self(), :subscribe_events, 3_000)

    {:ok, state}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    # JayBus에서 darwin 이벤트 수신
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Registry.register(TeamJay.JayBus, Topics.verification_passed(), [])
    Logger.debug("[DarwinLead] 이벤트 버스 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    new_state = handle_bus_event(topic, payload, state)
    {:noreply, new_state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      autonomy_level: state.autonomy_level,
      consecutive_successes: state.consecutive_successes,
      applied_successes: state.applied_successes,
      current_phase: state.current_phase,
      active_papers: length(state.active_papers),
      pipeline_runs: state.pipeline_runs
    }, state}
  end

  def handle_call(:get_autonomy_level, _from, state) do
    {:reply, state.autonomy_level, state}
  end

  @impl true
  def handle_cast({:paper_discovered, paper}, state) do
    Logger.info("[DarwinLead] 논문 발견: #{paper["title"] || paper[:title] || "unknown"}")
    new_papers = [paper | Enum.take(state.active_papers, 49)]
    {:noreply, %{state | active_papers: new_papers, current_phase: :evaluate}}
  end

  def handle_cast({:paper_evaluated, paper, score}, state) do
    if score >= 7 do
      Logger.info("[DarwinLead] 고적합 논문 (#{score}점): #{paper["title"] || "unknown"} → 구현 계획 수립")
      maybe_plan_implementation(paper, score, state)
    end
    {:noreply, %{state | current_phase: :plan}}
  end

  def handle_cast(:pipeline_success, state) do
    new_successes = state.consecutive_successes + 1
    new_state = %{state |
      consecutive_successes: new_successes,
      last_success_at: DateTime.utc_now(),
      pipeline_runs: state.pipeline_runs + 1,
      current_phase: :learn
    }

    new_state = maybe_upgrade_autonomy(new_state)
    {:noreply, new_state}
  end

  def handle_cast(:application_success, state) do
    new_state = %{state |
      consecutive_successes: state.consecutive_successes + 1,
      applied_successes: state.applied_successes + 1,
      last_success_at: DateTime.utc_now(),
      pipeline_runs: state.pipeline_runs + 1,
      current_phase: :learn
    }

    new_state = maybe_upgrade_autonomy(new_state)
    {:noreply, new_state}
  end

  def handle_cast({:pipeline_failure, reason}, state) do
    Logger.warning("[DarwinLead] 파이프라인 실패: #{reason}")
    new_state = %{state | consecutive_successes: 0, current_phase: :idle}
    {:noreply, new_state}
  end

  # ── 헬퍼 ───────────────────────────────────────────────────────────

  defp handle_bus_event(topic, payload, state) do
    cond do
      topic == Topics.paper_discovered() ->
        paper = payload[:paper] || payload
        new_papers = [paper | Enum.take(state.active_papers, 49)]
        %{state | active_papers: new_papers}

      topic == Topics.verification_passed() ->
        Logger.info("[DarwinLead] 검증 통과 → 적용 단계")
        %{state | current_phase: :apply}

      true ->
        state
    end
  end

  defp maybe_plan_implementation(paper, score, state) do
    if state.autonomy_level >= 4 do
      Logger.info("[DarwinLead] L#{state.autonomy_level}: 자동 구현 계획 수립")
      # Edison 트리거 (Phase 2에서 구현)
    else
      Logger.info("[DarwinLead] L3: 마스터 승인 필요 (score=#{score})")
      Task.start(fn ->
        HubClient.post_alarm(
          "🔬 다윈팀 고적합 논문 발견!\n제목: #{paper["title"] || "unknown"}\n적합성: #{score}/10\n→ 구현 승인 필요",
          "darwin", "darwin"
        )
      end)
    end
  end

  defp maybe_upgrade_autonomy(%{autonomy_level: level, consecutive_successes: successes,
                                  last_success_at: last} = state)
       when level == 3 and successes >= 5 do
    days_since = if last, do: DateTime.diff(DateTime.utc_now(), last, :day), else: 0

    if days_since >= 7 do
      Logger.info("[DarwinLead] L3→L4 자동 승격! (연속 #{successes}회 성공, #{days_since}일 경과)")
      new_state = %{state | autonomy_level: 4, level_upgraded_at: DateTime.utc_now()}
      save_autonomy_state(new_state)

      Task.start(fn ->
        HubClient.post_alarm("🎉 다윈팀 자율 레벨 L3→L4 승격!\n연속 성공: #{successes}회\n경과: #{days_since}일", "darwin", "darwin")
      end)

      new_state
    else
      state
    end
  end

  defp maybe_upgrade_autonomy(%{autonomy_level: level, consecutive_successes: successes,
                                  applied_successes: applied,
                                  level_upgraded_at: upgraded_at} = state)
       when level == 4 and successes >= 10 and applied >= 3 do
    days_since = if upgraded_at,
      do: DateTime.diff(DateTime.utc_now(), upgraded_at, :day),
      else: 0

    if days_since >= 14 do
      Logger.info("[DarwinLead] L4→L5 자동 승격! (연속 #{successes}회, 적용 #{applied}회, #{days_since}일 경과)")
      new_state = %{state | autonomy_level: 5, level_upgraded_at: DateTime.utc_now()}
      save_autonomy_state(new_state)

      Task.start(fn ->
        HubClient.post_alarm(
          "🏆 다윈팀 완전자율 L5 달성!\n연속 성공: #{successes}회\n적용 성공: #{applied}회\n경과: #{days_since}일",
          "darwin", "darwin"
        )
      end)

      new_state
    else
      Logger.debug("[DarwinLead] L4 승격 대기 중: #{days_since}/14일 경과")
      state
    end
  end

  defp maybe_upgrade_autonomy(state), do: state

  defp load_autonomy_state do
    path = Path.join(System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"), @autonomy_file)
    case File.read(path) do
      {:ok, content} ->
        data = Jason.decode!(content)
        %__MODULE__{
          autonomy_level: data["level"] || 3,
          consecutive_successes: data["consecutiveSuccesses"] || 0
        }
      _ ->
        %__MODULE__{}
    end
  end

  defp save_autonomy_state(state) do
    path = Path.join(System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"), @autonomy_file)
    content = Jason.encode!(%{
      level: state.autonomy_level,
      consecutiveSuccesses: state.consecutive_successes,
      upgradedAt: DateTime.to_iso8601(state.level_upgraded_at || DateTime.utc_now())
    })
    File.write(path, content)
  end
end
