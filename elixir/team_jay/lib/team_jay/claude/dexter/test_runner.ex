defmodule TeamJay.Claude.Dexter.TestRunner do
  @moduledoc """
  덱스터 테스트 오케스트레이터 — Layer 1/2/3 테스트 관리

  Layer 1: 인프라 헬스 (dexter.ts --telegram)
  Layer 2: 코드 무결성 (dexter.ts --full)
  Layer 3: 에러 분석 (dexter.ts --daily-report)

  - 주기 실행은 launchd가 소유한다. Elixir 내부 스케줄은 명시적으로 활성화한 경우만 사용한다.
  - 수동 트리거: run_now(layer)
  """

  use GenServer
  require Logger

  alias TeamJay.Claude.Topics

  @layer1_interval 300_000     # 5분
  @layer2_interval 3_600_000   # 1시간

  defstruct [
    layer1_failures: 0,
    layer2_failures: 0,
    last_layer1: nil,
    last_layer2: nil,
    last_layer3: nil,
    run_history: []   # 최근 10건 실행 이력
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ── Public API ──────────────────────────────────────────────────────

  def run_now(layer \\ 1) do
    GenServer.cast(__MODULE__, {:run, layer})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @doc false
  def scheduler_enabled?(env \\ System.get_env()) do
    Map.get(env, "TEAM_JAY_DEXTER_SCHEDULER_ENABLED") == "true"
  end

  # ── GenServer ───────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    if scheduler_enabled?() do
      Process.send_after(self(), :layer1_tick, 10_000)
      Process.send_after(self(), :layer2_tick, 60_000)
      Logger.info("[TestRunner] 덱스터 내부 스케줄러 시작")
    else
      Logger.info("[TestRunner] launchd 소유 모드; 수동 트리거만 활성")
    end

    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:layer1_tick, state) do
    Process.send_after(self(), :layer1_tick, @layer1_interval)
    {:noreply, run_layer(1, state)}
  end

  def handle_info(:layer2_tick, state) do
    Process.send_after(self(), :layer2_tick, @layer2_interval)
    {:noreply, run_layer(2, state)}
  end

  @impl true
  def handle_cast({:run, layer}, state) do
    {:noreply, run_layer(layer, state)}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      layer1_failures: state.layer1_failures,
      layer2_failures: state.layer2_failures,
      last_layer1: state.last_layer1,
      last_layer2: state.last_layer2,
      recent_runs: Enum.take(state.run_history, 5)
    }, state}
  end

  # ── 레이어 실행 ────────────────────────────────────────────────────

  defp run_layer(layer, state) do
    Logger.debug("[TestRunner] Layer #{layer} 테스트 시작")
    now = DateTime.utc_now()

    # dexter PortAgent에 run 신호 — PortAgent가 tsx로 실행
    agent = layer_agent(layer)
    pid = GenServer.whereis({:via, Registry, {TeamJay.AgentRegistry, agent}})

    result = if pid do
      send(pid, :run)
      :triggered
    else
      Logger.warning("[TestRunner] #{agent} PortAgent 없음")
      :no_agent
    end

    entry = %{layer: layer, result: result, at: now}
    new_history = [entry | Enum.take(state.run_history, 9)]

    # broadcast
    Jay.Core.JayBus |> Registry.dispatch(Topics.test_started("layer#{layer}"), fn entries ->
      Enum.each(entries, fn {pid, _} ->
        send(pid, {:claude_event, Topics.test_started("layer#{layer}"), entry})
      end)
    end)

    case layer do
      1 -> %{state | last_layer1: now, run_history: new_history}
      2 -> %{state | last_layer2: now, run_history: new_history}
      3 -> %{state | last_layer3: now, run_history: new_history}
      _ -> %{state | run_history: new_history}
    end
  end

  # launchd ai.claude.dexter.quick가 주기 실행의 canonical owner다.
  # 수동 검증 요청만 기존 PortAgent 이름으로 전달한다.
  defp layer_agent(1), do: :dexter
  defp layer_agent(2), do: :dexter         # 전체 체크
  defp layer_agent(3), do: :dexter_daily   # 일일 리포트
  defp layer_agent(_), do: :dexter
end
