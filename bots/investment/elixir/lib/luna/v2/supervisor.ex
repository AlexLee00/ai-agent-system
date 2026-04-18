defmodule Luna.V2.Supervisor do
  @moduledoc """
  Luna V2 OTP Supervisor — 투자팀 자율 에이전트 트리 관리.

  Kill Switch(환경변수) 기반 단계적 기동:
    Phase 1: PubSub + MAPE-K Monitor (항상 ON, 시장 감시)
    Phase 2: Commander (Jido.AI.Agent) — LUNA_COMMANDER_ENABLED=true
    Phase 3: MAPE-K 전체 루프 — LUNA_MAPEK_ENABLED=true
  """

  use Supervisor
  require Logger

  alias Luna.V2.KillSwitch

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if KillSwitch.v2_enabled?() do
      children = core_children() ++ commander_children() ++ mapek_children()
      Logger.info("[루나V2] 수퍼바이저 기동 — #{length(children)}개 자식 프로세스")
      Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
    else
      Logger.info("[루나V2] V2 비활성 — 빈 수퍼바이저 트리")
      Supervisor.init([], strategy: :one_for_one)
    end
  end

  defp core_children do
    [{Phoenix.PubSub, name: Luna.V2.PubSub}]
  end

  defp commander_children do
    # Commander는 Jido.AI.Agent 모듈 — GenServer로 직접 기동하지 않음
    # 향후 AgentServer 패턴 도입 시 활성화
    []
  end

  defp mapek_children do
    if KillSwitch.mapek_enabled?() do
      [
        Luna.V2.MAPEK.Monitor,
        Luna.V2.MAPEK.Knowledge,
      ]
    else
      []
    end
  end
end
