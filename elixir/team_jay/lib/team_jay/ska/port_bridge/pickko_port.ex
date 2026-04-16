defmodule TeamJay.Ska.PortBridge.PickkoPort do
  @moduledoc """
  픽코 Playwright PortAgent 브리지

  Phase 1 역할:
    - SkaBus 이벤트 → PortAgent(:jimmy) 명령 변환
    - KioskAgent 명령 큐 → jimmy 실행 트리거
    - 실행 결과 → PickkoMonitor 전달
    - 키오스크 오류 → FailureTracker 보고

  KioskAgent가 명령을 큐에 추가하면,
  이 PortBridge가 jimmy(Node.js PortAgent)에게 전달합니다.

  Phase 3.5에서 stdin/stdout 프로토콜로 전환하여
  개별 명령을 주입할 수 있도록 확장 예정입니다.
  """

  use GenServer
  require Logger

  defstruct [
    :jimmy_status,
    :last_command_at,
    :command_log,
    :pending_commands
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Jimmy PortAgent 재시작"
  def request_restart(reason \\ :error_recovery) do
    GenServer.cast(__MODULE__, {:request_restart, reason})
  end

  @doc "Jimmy 사이클 결과 수신"
  def receive_cycle_result(result) when is_map(result) do
    GenServer.cast(__MODULE__, {:cycle_result, result})
  end

  @doc "포트 브리지 상태 조회"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[PickkoPort] 시작! 픽코 PortBridge 활성화")
    TeamJay.Ska.PubSub.subscribe(:failure_reported)
    TeamJay.Ska.PubSub.subscribe(:kiosk_command_enqueued)

    {:ok, %__MODULE__{
      jimmy_status: :unknown,
      last_command_at: nil,
      command_log: [],
      pending_commands: 0
    }}
  end

  @impl true
  def handle_cast({:request_restart, reason}, state) do
    Logger.info("[PickkoPort] jimmy 재시작 요청: #{reason}")

    case Registry.lookup(TeamJay.AgentRegistry, :jimmy) do
      [{pid, _}] ->
        Logger.info("[PickkoPort] jimmy PID #{inspect(pid)} 재시작 트리거")
        GenServer.cast(pid, :stop)
      [] ->
        Logger.warning("[PickkoPort] jimmy 프로세스를 찾을 수 없음")
    end

    log_entry = %{event: :restart_requested, reason: reason, at: DateTime.utc_now()}
    new_log = Enum.take([log_entry | state.command_log], 20)

    {:noreply, %{state |
      last_command_at: DateTime.utc_now(),
      command_log: new_log
    }}
  end

  @impl true
  def handle_cast({:cycle_result, result}, state) do
    TeamJay.Ska.Pickko.PickkoMonitor.report_cycle(result)

    {:noreply, %{state |
      jimmy_status: (if Map.get(result, :success, false), do: :ok, else: :degraded),
      pending_commands: max(state.pending_commands - 1, 0)
    }}
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, %{agent: "jimmy", action: :session_refresh}}, state) do
    request_restart(:session_refresh)
    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :kiosk_command_enqueued, %{command_id: cmd_id, type: type}}, state) do
    Logger.info("[PickkoPort] 명령 큐 수신: #{type} (#{cmd_id})")

    log_entry = %{
      event: :command_enqueued,
      command_id: cmd_id,
      type: type,
      at: DateTime.utc_now()
    }
    new_log = Enum.take([log_entry | state.command_log], 50)

    # Phase 1: 명령이 큐에 쌓이면 jimmy 실행 트리거
    # Phase 3.5: jimmy에 stdin으로 개별 명령 전송
    case Registry.lookup(TeamJay.AgentRegistry, :jimmy) do
      [{pid, _}] -> GenServer.cast(pid, :run)
      [] -> Logger.warning("[PickkoPort] jimmy 프로세스를 찾을 수 없음")
    end

    {:noreply, %{state |
      pending_commands: state.pending_commands + 1,
      command_log: new_log
    }}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      jimmy_status: state.jimmy_status,
      last_command_at: state.last_command_at,
      pending_commands: state.pending_commands,
      recent_commands: Enum.take(state.command_log, 10)
    }, state}
  end
end
