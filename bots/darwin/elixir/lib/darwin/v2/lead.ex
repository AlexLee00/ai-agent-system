defmodule Darwin.V2.Lead do
  @moduledoc """
  다윈 V2 팀장 — 7단계 자율 사이클 총 조율자 (GenServer).

  TeamJay.Darwin.TeamLead의 V2 진화 포트. AutonomyLevel GenServer로 상태 위임.
  JayBus 이벤트 구독 + 사이클 단계 전환 제어.

  ## V2 추가 기능
  - Kill Switch 통합 (kill_switch 필드, L4/L5 자동 액션 차단)
  - 실패 시 Darwin.V2.Reflexion.reflect/2 비동기 트리거
  - 단계 전환 시 Darwin.V2.PubSub 브로드캐스트
  - 자율 레벨 승격 시 Topics.autonomy_upgraded/0 브로드캐스트
  - 일일 LLM 비용 추적 (CostTracker 연동)

  ## 자율 레벨 전환 규칙
  - L3 → L4: consecutive_successes >= 5 AND days_at_current_level >= 7
  - L4 → L5: consecutive_successes >= 10 AND applied_successes >= 3 AND days_at_current_level >= 14
  - 실패 시: consecutive_successes = 0, L5이면 L4로 강등

  ## Kill Switch 규칙
  - kill_switch == true → L4/L5 자동 액션 차단 (마스터 승인 필요)
  - kill_switch 초기값 true (잠금 상태로 시작)
  - deactivate_kill_switch/0 호출 시만 L4/L5 자동 액션 허용
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, AutonomyLevel}
  alias TeamJay.HubClient

  @autonomy_file "bots/darwin/sandbox/darwin-autonomy-level.json"

  defstruct [
    autonomy_level: 3,
    consecutive_successes: 0,
    applied_successes: 0,
    days_at_current_level: 0,
    last_upgrade_at: nil,
    current_phase: :idle,
    active_papers: [],
    daily_cost_usd: 0.0,
    kill_switch: true,        # true = 잠금 상태로 시작
    pipeline_runs: 0
  ]

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec get_status() :: map()
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @spec paper_discovered(map()) :: :ok
  def paper_discovered(paper) do
    GenServer.cast(__MODULE__, {:paper_discovered, paper})
  end

  @spec paper_evaluated(map(), number()) :: :ok
  def paper_evaluated(paper, score) do
    GenServer.cast(__MODULE__, {:paper_evaluated, paper, score})
  end

  @spec pipeline_success() :: :ok
  def pipeline_success do
    GenServer.cast(__MODULE__, :pipeline_success)
  end

  @spec pipeline_failure(term()) :: :ok
  def pipeline_failure(reason) do
    GenServer.cast(__MODULE__, {:pipeline_failure, reason})
  end

  @spec record_application_success() :: :ok
  def record_application_success do
    GenServer.cast(__MODULE__, :application_success)
  end

  @spec activate_kill_switch() :: :ok
  def activate_kill_switch do
    GenServer.cast(__MODULE__, :activate_kill_switch)
  end

  @spec deactivate_kill_switch() :: :ok
  def deactivate_kill_switch do
    GenServer.cast(__MODULE__, :deactivate_kill_switch)
  end

  @spec get_autonomy_level() :: 3 | 4 | 5
  def get_autonomy_level do
    GenServer.call(__MODULE__, :get_autonomy_level)
  end

  # ──────────────────────────────────────────────
  # GenServer — init
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    state = load_state()
    Logger.info("[다윈V2 리드] 팀장 V2 시작! 자율 레벨 L#{state.autonomy_level}, kill_switch=#{state.kill_switch}")
    Process.send_after(self(), :subscribe_events, 3_000)
    {:ok, state}
  end

  # ──────────────────────────────────────────────
  # GenServer — handle_info
  # ──────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Registry.register(TeamJay.JayBus, Topics.verification_passed(), [])
    Registry.register(TeamJay.JayBus, Topics.verification_failed(), [])
    Registry.register(TeamJay.JayBus, Topics.applied("claude"), [])
    Logger.debug("[다윈V2 리드] JayBus 이벤트 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    new_state = handle_bus_event(topic, payload, state)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ──────────────────────────────────────────────
  # GenServer — handle_call
  # ──────────────────────────────────────────────

  @impl GenServer
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      autonomy_level:       state.autonomy_level,
      phase:                state.current_phase,
      active_papers:        length(state.active_papers),
      consecutive_successes: state.consecutive_successes,
      applied_successes:    state.applied_successes,
      days_at_current_level: state.days_at_current_level,
      daily_cost_usd:       state.daily_cost_usd,
      kill_switch:          state.kill_switch,
      pipeline_runs:        state.pipeline_runs
    }, state}
  end

  def handle_call(:get_autonomy_level, _from, state) do
    {:reply, state.autonomy_level, state}
  end

  # ──────────────────────────────────────────────
  # GenServer — handle_cast
  # ──────────────────────────────────────────────

  @impl GenServer
  def handle_cast({:paper_discovered, paper}, state) do
    Logger.info("[다윈V2 리드] 논문 발견: #{paper["title"] || paper[:title] || "unknown"}")
    papers = [paper | Enum.take(state.active_papers, 49)]
    new_state = transition_phase(%{state | active_papers: papers}, :evaluate)
    {:noreply, new_state}
  end

  def handle_cast({:paper_evaluated, paper, score}, state) do
    if score >= 7 do
      maybe_trigger_plan(paper, score, state)
    end
    new_state = transition_phase(state, :plan)
    {:noreply, new_state}
  end

  def handle_cast(:pipeline_success, state) do
    new_successes = state.consecutive_successes + 1
    new_state = %{state |
      consecutive_successes: new_successes,
      pipeline_runs: state.pipeline_runs + 1,
      daily_cost_usd: fetch_daily_cost()
    }
    new_state = maybe_upgrade_autonomy(new_state)
    new_state = transition_phase(new_state, :learn)
    save_state(new_state)
    {:noreply, new_state}
  end

  def handle_cast(:application_success, state) do
    new_state = %{state |
      consecutive_successes: state.consecutive_successes + 1,
      applied_successes: state.applied_successes + 1,
      pipeline_runs: state.pipeline_runs + 1,
      daily_cost_usd: fetch_daily_cost()
    }
    new_state = maybe_upgrade_autonomy(new_state)
    new_state = transition_phase(new_state, :learn)
    save_state(new_state)
    AutonomyLevel.record_applied_success()
    {:noreply, new_state}
  end

  def handle_cast({:pipeline_failure, reason}, state) do
    Logger.warning("[다윈V2 리드] 파이프라인 실패: #{inspect(reason)}")

    # Reflexion 비동기 트리거
    Task.start(fn ->
      failure_context = %{
        trigger: :pipeline_failure,
        phase:   to_string(state.current_phase),
        action:  %{phase: state.current_phase},
        error:   reason
      }
      Darwin.V2.Reflexion.reflect(failure_context, nil)
    end)

    # L5이면 L4로 강등
    new_level = if state.autonomy_level == 5, do: 4, else: state.autonomy_level
    if new_level != state.autonomy_level do
      Logger.info("[다윈V2 리드] L5 → L4 강등 (파이프라인 실패)")
      broadcast_topic(Topics.autonomy_degraded(), %{from: state.autonomy_level, to: new_level, reason: reason})
    end

    new_state = %{state |
      consecutive_successes: 0,
      autonomy_level: new_level
    }
    new_state = transition_phase(new_state, :idle)
    save_state(new_state)
    AutonomyLevel.record_failure(reason)
    {:noreply, new_state}
  end

  def handle_cast(:activate_kill_switch, state) do
    Logger.warning("[다윈V2 리드] Kill Switch 활성화 — L4/L5 자동 액션 차단")
    {:noreply, %{state | kill_switch: true}}
  end

  def handle_cast(:deactivate_kill_switch, state) do
    Logger.info("[다윈V2 리드] Kill Switch 비활성화 — 마스터 명시적 허용")
    {:noreply, %{state | kill_switch: false}}
  end

  # ──────────────────────────────────────────────
  # Private — JayBus 이벤트
  # ──────────────────────────────────────────────

  defp handle_bus_event(topic, payload, state) do
    cond do
      topic == Topics.paper_discovered() ->
        paper = payload[:paper] || payload
        Logger.debug("[다윈V2 리드] JayBus paper_discovered 수신")
        %{state | active_papers: [paper | Enum.take(state.active_papers, 49)]}

      topic == Topics.verification_passed() ->
        Logger.info("[다윈V2 리드] 검증 통과 → 적용 단계")
        transition_phase(state, :apply)

      topic == Topics.verification_failed() ->
        reason = payload[:reason] || payload["reason"] || "verification_failed"
        Logger.warning("[다윈V2 리드] 검증 실패: #{inspect(reason)}")
        paper = payload[:paper] || payload["paper"]
        Task.start(fn ->
          failure_context = %{
            trigger: :verifier_rejection,
            phase:   "verify",
            action:  %{topic: topic},
            error:   reason
          }
          Darwin.V2.Reflexion.reflect(failure_context, paper)
        end)
        transition_phase(state, :idle)

      topic == Topics.applied("claude") ->
        Logger.info("[다윈V2 리드] 적용 성공 (claude)")
        GenServer.cast(self(), :application_success)
        state

      true ->
        state
    end
  end

  # ──────────────────────────────────────────────
  # Private — 단계 전환 + PubSub 브로드캐스트
  # ──────────────────────────────────────────────

  defp transition_phase(state, new_phase) do
    if state.current_phase != new_phase do
      Logger.debug("[다윈V2 리드] 단계 전환: #{state.current_phase} → #{new_phase}")
      broadcast_topic("darwin.phase.changed", %{from: state.current_phase, to: new_phase})
    end
    %{state | current_phase: new_phase}
  end

  defp broadcast_topic(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, topic, payload})
      end
    end)
  end

  # ──────────────────────────────────────────────
  # Private — L4/L5 자동 구현 계획 트리거
  # ──────────────────────────────────────────────

  defp maybe_trigger_plan(paper, score, state) do
    level = state.autonomy_level

    cond do
      state.kill_switch and level >= 4 ->
        Logger.warning("[다윈V2 리드] Kill Switch 활성 — L#{level} 자동 액션 차단 (마스터 승인 필요)")
        Task.start(fn ->
          HubClient.post_alarm(
            "🔒 다윈팀 Kill Switch 활성 상태\n고적합 논문 발견됐으나 자동 구현 차단됨\n제목: #{paper["title"] || paper[:title] || "unknown"}\n적합성: #{score}/10\n→ 마스터 승인 후 deactivate_kill_switch/0 호출 필요",
            "darwin", "darwin"
          )
        end)

      level >= 4 ->
        Logger.info("[다윈V2 리드] L#{level}: 자동 구현 계획 수립 (score=#{score})")

      true ->
        Logger.info("[다윈V2 리드] L3: 마스터 승인 필요 (score=#{score})")
        Task.start(fn ->
          HubClient.post_alarm(
            "🔬 다윈팀 고적합 논문 발견!\n제목: #{paper["title"] || paper[:title] || "unknown"}\n적합성: #{score}/10\n→ 구현 승인 필요",
            "darwin", "darwin"
          )
        end)
    end
  end

  # ──────────────────────────────────────────────
  # Private — 자율 레벨 승격 로직
  # ──────────────────────────────────────────────

  # L3 → L4: 연속 5회 성공 + 7일 경과
  defp maybe_upgrade_autonomy(%{autonomy_level: 3, consecutive_successes: s} = state) when s >= 5 do
    days = state.days_at_current_level

    if days >= 7 do
      Logger.info("[다윈V2 리드] L3→L4 자동 승격! (연속 #{s}회 성공, #{days}일 경과)")
      new_state = %{state |
        autonomy_level: 4,
        last_upgrade_at: DateTime.utc_now(),
        days_at_current_level: 0
      }
      broadcast_topic(Topics.autonomy_upgraded(), %{from: 3, to: 4, successes: s, days: days})
      Task.start(fn ->
        HubClient.post_alarm(
          "🎉 다윈팀 자율 레벨 L3→L4 승격!\n연속 성공: #{s}회\n경과: #{days}일",
          "darwin", "darwin"
        )
      end)
      AutonomyLevel.record_success()
      new_state
    else
      Logger.debug("[다윈V2 리드] L3 승격 대기: #{days}/7일 경과")
      state
    end
  end

  # L4 → L5: 연속 10회 성공 + 적용 3회 + 14일 경과
  defp maybe_upgrade_autonomy(%{autonomy_level: 4, consecutive_successes: s, applied_successes: a} = state)
       when s >= 10 and a >= 3 do
    days = state.days_at_current_level

    if days >= 14 do
      Logger.info("[다윈V2 리드] L4→L5 완전자율 달성! (연속 #{s}회, 적용 #{a}회, #{days}일 경과)")
      new_state = %{state |
        autonomy_level: 5,
        last_upgrade_at: DateTime.utc_now(),
        days_at_current_level: 0
      }
      broadcast_topic(Topics.autonomy_upgraded(), %{from: 4, to: 5, successes: s, applied: a, days: days})
      Task.start(fn ->
        HubClient.post_alarm(
          "🏆 다윈팀 완전자율 L5 달성!\n연속 성공: #{s}회\n적용 성공: #{a}회\n경과: #{days}일",
          "darwin", "darwin"
        )
      end)
      AutonomyLevel.record_success()
      new_state
    else
      Logger.debug("[다윈V2 리드] L4 승격 대기: #{days}/14일 경과")
      state
    end
  end

  defp maybe_upgrade_autonomy(state), do: state

  # ──────────────────────────────────────────────
  # Private — 비용 추적
  # ──────────────────────────────────────────────

  defp fetch_daily_cost do
    case Darwin.V2.LLM.CostTracker.check_budget() do
      {:ok, %{total_usd: usd}} -> usd
      {:ok, budget} when is_map(budget) -> Map.get(budget, :total_usd, 0.0)
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end

  # ──────────────────────────────────────────────
  # Private — 상태 영속화 (JSON)
  # ──────────────────────────────────────────────

  defp load_state do
    path = Path.join(
      System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"),
      @autonomy_file
    )

    case File.read(path) do
      {:ok, content} ->
        data = Jason.decode!(content)
        %__MODULE__{
          autonomy_level:        data["level"] || 3,
          consecutive_successes: data["consecutiveSuccesses"] || 0,
          applied_successes:     data["appliedSuccesses"] || 0,
          days_at_current_level: data["daysAtCurrentLevel"] || 0,
          last_upgrade_at:       parse_datetime(data["lastUpgradeAt"]),
          kill_switch:           Map.get(data, "killSwitch", true),
          pipeline_runs:         data["pipelineRuns"] || 0
        }

      _ ->
        %__MODULE__{}
    end
  rescue
    _ -> %__MODULE__{}
  end

  defp save_state(state) do
    path = Path.join(
      System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"),
      @autonomy_file
    )

    content = Jason.encode!(%{
      level:                 state.autonomy_level,
      consecutiveSuccesses:  state.consecutive_successes,
      appliedSuccesses:      state.applied_successes,
      daysAtCurrentLevel:    state.days_at_current_level,
      killSwitch:            state.kill_switch,
      pipelineRuns:          state.pipeline_runs,
      lastUpgradeAt:         if(state.last_upgrade_at, do: DateTime.to_iso8601(state.last_upgrade_at), else: nil),
      savedAt:               DateTime.to_iso8601(DateTime.utc_now())
    })

    File.write(path, content)
  end

  defp parse_datetime(nil), do: nil
  defp parse_datetime(str) when is_binary(str) do
    case DateTime.from_iso8601(str) do
      {:ok, dt, _} -> dt
      _ -> nil
    end
  end
  defp parse_datetime(_), do: nil
end
