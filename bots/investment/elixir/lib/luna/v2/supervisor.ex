defmodule Luna.V2.Supervisor do
  @moduledoc """
  Luna V2 OTP Supervisor — 투자팀 완전자율 에이전트 트리 관리.

  Kill Switch(환경변수) 기반 단계적 기동:
    Phase 1: PubSub + MAPE-K Monitor (항상 ON)
    Phase 2: MAPE-K Knowledge + 전체 루프 — LUNA_MAPEK_ENABLED=true
    Phase 3: Strategy Registry — LUNA_V2_ENABLED=true
    Phase 4: Validation Engine — LUNA_VALIDATION_ENABLED=true
    Phase 5: Prediction Engine — LUNA_PREDICTION_ENABLED=true
    Phase 6: MapeK Loop (MAPE-K 완전자율) — LUNA_MAPEK_ENABLED=true
  """

  use Supervisor
  require Logger

  alias Luna.V2.KillSwitch

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if KillSwitch.v2_enabled?() do
      children =
        core_children() ++
        position_watch_children() ++
        mapek_children() ++
        registry_children() ++
        validation_children() ++
        prediction_children() ++
        mapek_loop_children() ++
        scheduler_children() ++
        telegram_children()

      Logger.info("[루나V2] 수퍼바이저 기동 — #{length(children)}개 자식")
      Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
    else
      Logger.info("[루나V2] V2 비활성 — 빈 수퍼바이저")
      Supervisor.init([], strategy: :one_for_one)
    end
  end

  defp core_children do
    [
      {Phoenix.PubSub, name: Luna.V2.PubSub},
      Luna.V2.LLM.CostTracker,
      Luna.V2.LLM.RoutingLog,
    ]
  end

  defp mapek_children do
    if KillSwitch.mapek_enabled?() do
      [Luna.V2.MAPEK.Monitor, Luna.V2.MAPEK.Knowledge]
    else
      [Luna.V2.MAPEK.Monitor]  # Monitor는 항상 기동 (시장 감시)
    end
  end

  defp position_watch_children do
    if KillSwitch.position_watch_enabled?() do
      [Luna.V2.PositionWatch]
    else
      []
    end
  end

  defp registry_children do
    if KillSwitch.strategy_registry_enabled?() do
      [Luna.V2.Registry.StrategyRegistry]
    else
      []
    end
  end

  defp validation_children do
    if KillSwitch.validation_enabled?() do
      [Luna.V2.Validation.Engine]
    else
      []
    end
  end

  defp prediction_children do
    if KillSwitch.prediction_enabled?() do
      [Luna.V2.Prediction.Engine]
    else
      []
    end
  end

  defp mapek_loop_children do
    if KillSwitch.mapek_enabled?() and KillSwitch.auto_mode?() do
      [Luna.V2.MapeKLoop]
    else
      []
    end
  end

  defp scheduler_children do
    if KillSwitch.scheduler_enabled?() do
      [Luna.V2.Scheduler]
    else
      []
    end
  end

  defp telegram_children do
    if KillSwitch.telegram_enabled?() do
      [Luna.V2.TelegramReporter]
    else
      []
    end
  end
end
