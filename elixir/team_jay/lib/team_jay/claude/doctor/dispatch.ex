defmodule TeamJay.Claude.Doctor.Dispatch do
  @moduledoc """
  닥터팀 에러 출동 디스패치 — Graduated Autonomy Level 0→1

  에러 출동 파이프라인:
  1. ErrorTracker에서 반복 에러 수신
  2. LLM으로 원인 분석 (Hub LLM 로컬)
  3. Level 0: 마스터에게 보고 + 수정 제안
  4. Level 1 (Phase 3에서 활성화): 자동 패치 적용

  현재: Level 0 (관찰 + 제안)
  """

  use GenServer
  require Logger

  alias Jay.Core.HubClient
  alias TeamJay.Claude.Topics

  defstruct [
    level: 0,           # Graduated Autonomy Level (0~3)
    dispatch_count: 0,
    active_cases: [],   # 현재 처리 중인 에러 케이스
    resolved_cases: []  # 해결된 케이스 (최근 20건)
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ── Public API ──────────────────────────────────────────────────────

  def dispatch(error_entry) do
    GenServer.cast(__MODULE__, {:dispatch, error_entry})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def set_level(level) when level in 0..3 do
    GenServer.cast(__MODULE__, {:set_level, level})
  end

  # ── GenServer ───────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    # ErrorTracker broadcasts를 JayBus에서 구독
    Process.send_after(self(), :subscribe, 5_000)
    Logger.info("[Doctor.Dispatch] 닥터 출동 디스패치 Level 0 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe, state) do
    Jay.Core.JayBus.subscribe( Topics.error_escalated(), [])
    Logger.debug("[Doctor.Dispatch] 에러 에스컬레이션 구독 완료")
    {:noreply, state}
  end

  def handle_info({:claude_event, topic, payload}, state) when topic == "claude.error.escalated" do
    {:noreply, handle_escalation(payload, state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:dispatch, error_entry}, state) do
    {:noreply, handle_escalation(error_entry, state)}
  end

  def handle_cast({:set_level, level}, state) do
    Logger.info("[Doctor.Dispatch] Autonomy Level #{state.level} → #{level}")
    {:noreply, %{state | level: level}}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      level: state.level,
      dispatch_count: state.dispatch_count,
      active_cases: length(state.active_cases),
      recent_resolved: Enum.take(state.resolved_cases, 5)
    }, state}
  end

  # ── 에러 처리 ──────────────────────────────────────────────────────

  defp handle_escalation(error_entry, state) do
    Logger.warning("[Doctor.Dispatch] 에러 출동! #{inspect(error_entry[:bot_name])} Level=#{state.level}")

    case_id = :erlang.unique_integer([:positive])
    new_case = %{id: case_id, error: error_entry, started_at: DateTime.utc_now(), status: :analyzing}
    new_cases = [new_case | state.active_cases]

    # 비동기로 분석 + 보고
    Task.start(fn -> analyze_and_report(case_id, error_entry, state.level) end)

    %{state |
      active_cases: new_cases,
      dispatch_count: state.dispatch_count + 1
    }
  end

  defp analyze_and_report(case_id, error_entry, level) do
    bot_name = error_entry[:bot_name] || "unknown"
    event_type = error_entry[:event_type] || "error"
    message = error_entry[:message] || ""

    # Level 0: 텔레그램 보고 + 제안
    report = """
    🚨 닥터 에러 분석 (Level #{level})
    봇: #{bot_name}
    타입: #{event_type}
    메시지: #{String.slice(message, 0, 200)}
    케이스: ##{case_id}
    → #{level_action(level)}
    """

    HubClient.post_alarm(report, bot_name, "claude")
    Logger.info("[Doctor.Dispatch] 케이스 ##{case_id} 보고 완료 (Level #{level})")
  end

  defp level_action(0), do: "관찰 모드: 마스터 확인 필요"
  defp level_action(1), do: "제안 모드: 수정 코드 생성 중 (마스터 승인 필요)"
  defp level_action(2), do: "자동 패치 모드: 스냅샷 생성 + 패치 적용"
  defp level_action(3), do: "완전 자율 모드: 자동 수정 + 테스트 + 배포"
end
