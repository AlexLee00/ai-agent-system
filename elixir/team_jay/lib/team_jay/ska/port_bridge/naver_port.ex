defmodule TeamJay.Ska.PortBridge.NaverPort do
  @moduledoc """
  네이버 Playwright PortAgent 브리지

  Phase 1 역할:
    - SkaBus 이벤트 → PortAgent(:andy) 명령 변환
    - 세션 재로그인 요청 → andy 재시작 트리거
    - 파싱 결과 → NaverMonitor 전달
    - 셀렉터 무효화 → SelectorManager 캐시 클리어

  현재 Andy(PortAgent)는 Node.js 스크립트 전체를 실행합니다.
  Phase 3.5에서 stdin/stdout 프로토콜로 전환하여
  Elixir가 명령을 주입할 수 있도록 확장 예정입니다.
  """

  use GenServer
  require Logger

  defstruct [
    :andy_status,
    :last_command_at,
    :pending_refresh,
    :handoff_log
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Andy PortAgent 재시작 요청 (세션 갱신)"
  def request_restart(reason \\ :session_refresh) do
    GenServer.cast(__MODULE__, {:request_restart, reason})
  end

  @doc "파싱 결과 수신 (andy stdout JSON)"
  def receive_parse_result(result) when is_map(result) do
    GenServer.cast(__MODULE__, {:parse_result, result})
  end

  @doc "포트 브리지 상태 조회"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[NaverPort] 시작! 네이버 PortBridge 활성화")
    # 세션 갱신 요청 구독
    TeamJay.Ska.PubSub.subscribe(:failure_reported)
    TeamJay.Ska.PubSub.subscribe(:retry_requested)
    TeamJay.Ska.PubSub.subscribe(:reload_requested)

    {:ok, %__MODULE__{
      andy_status: :unknown,
      last_command_at: nil,
      pending_refresh: false,
      handoff_log: []
    }}
  end

  @impl true
  def handle_cast({:request_restart, reason}, state) do
    Logger.info("[NaverPort] andy 재시작 요청: #{reason}")

    # PortAgent 재시작 — SkaSupervisor를 통해 andy를 restart
    # Phase 1: PortAgent(:andy)는 Supervisor one_for_one이므로
    # 프로세스 종료 시 자동 재시작됨
    # 여기서는 andy의 pid를 찾아 정상 종료 트리거
    case Registry.lookup(TeamJay.AgentRegistry, :andy) do
      [{pid, _}] ->
        Logger.info("[NaverPort] andy PID #{inspect(pid)} 재시작 트리거")
        GenServer.cast(pid, :stop)
      [] ->
        Logger.warning("[NaverPort] andy 프로세스를 찾을 수 없음")
    end

    log_entry = %{event: :restart_requested, reason: reason, at: DateTime.utc_now()}
    new_log = Enum.take([log_entry | state.handoff_log], 20)

    {:noreply, %{state |
      pending_refresh: true,
      last_command_at: DateTime.utc_now(),
      handoff_log: new_log
    }}
  end

  @impl true
  def handle_cast({:parse_result, result}, state) do
    # andy가 반환한 JSON 결과를 NaverMonitor로 전달
    TeamJay.Ska.Naver.NaverMonitor.report_cycle(result)
    {:noreply, %{state | andy_status: :ok, pending_refresh: false}}
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, %{agent: "andy", action: :session_refresh}}, state) do
    request_restart(:session_refresh)
    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :retry_requested, %{agent: "andy"}}, state) do
    Logger.info("[NaverPort] andy 재시도 요청 수신")
    log_entry = %{event: :retry_requested, at: DateTime.utc_now()}
    new_log = Enum.take([log_entry | state.handoff_log], 20)
    {:noreply, %{state | handoff_log: new_log}}
  end

  @impl true
  def handle_info({:ska_event, :reload_requested, %{agent: "andy"}}, state) do
    Logger.info("[NaverPort] andy 페이지 재로드 요청")
    # Phase 3.5: stdin으로 reload 명령 전송
    # 현재: 재시작으로 대체
    request_restart(:page_reload)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      andy_status: state.andy_status,
      last_command_at: state.last_command_at,
      pending_refresh: state.pending_refresh,
      recent_handoffs: Enum.take(state.handoff_log, 5)
    }, state}
  end
end
