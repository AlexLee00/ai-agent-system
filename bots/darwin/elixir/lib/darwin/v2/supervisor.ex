defmodule Darwin.V2.Supervisor do
  @moduledoc """
  Darwin V2 OTP Supervisor — R&D 자율 에이전트 트리 관리.
  DARWIN_V2_ENABLED=true 시에만 자식 프로세스 기동.

  Phase 1: KillSwitch + Memory.L1 + CostTracker 활성화
  Phase 2: PubSub + RollbackScheduler + RoutingLog 추가
  Phase 3: 팀장(Lead) + 7개 사이클 에이전트 활성화
  Phase 4: FeedbackLoop + KeywordEvolver + ResearchMonitor 추가
  Phase 5: ShadowRunner (Shadow Mode) + HTTP(Bandit) + MCP Server 활성화
  Phase 6: TelegramBridge + 강화된 RollbackScheduler (24h 효과 측정) 추가
  """

  use Supervisor
  require Logger

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if Application.get_env(:darwin, :v2_enabled, false) do
      kill_switch_on = Application.get_env(:darwin, :kill_switch, true)

      children =
        core_children() ++
          cycle_children(kill_switch_on) ++
          support_children(kill_switch_on) ++
          maybe_shadow_children() ++
          maybe_http_children()

      Logger.info("[다윈V2] 수퍼바이저 기동 — #{length(children)}개 자식 프로세스")

      Supervisor.init(children,
        strategy: :one_for_one,
        max_restarts: 5,
        max_seconds: 60
      )
    else
      Logger.info("[다윈V2] V2 비활성 — 빈 수퍼바이저 트리")
      Supervisor.init([], strategy: :one_for_one)
    end
  end

  # ---
  # 항상 기동하는 핵심 인프라 자식

  defp core_children do
    [
      {Phoenix.PubSub, name: Darwin.V2.PubSub},
      Darwin.V2.Memory.L1,
      Darwin.V2.LLM.CostTracker,
      Darwin.V2.LLM.RoutingLog,
      Darwin.V2.RollbackScheduler,
      # Phase R: MAPE-K 완전자율 루프 (DARWIN_MAPEK_ENABLED=true 시 활성)
      Darwin.V2.MapeKLoop
    ]
  end

  # 사이클 에이전트 — 팀장 항상 ON, 나머지 kill_switch 제어
  defp cycle_children(kill_switch_on) do
    # Lead(팀장)는 kill_switch 무관하게 항상 기동
    lead = [Darwin.V2.Lead]

    workers =
      if kill_switch_on do
        [
          Darwin.V2.Scanner,
          Darwin.V2.Evaluator,
          Darwin.V2.Planner,
          Darwin.V2.Edison,
          Darwin.V2.Verifier,
          Darwin.V2.Applier
        ]
      else
        []
      end

    lead ++ workers
  end

  # 지원 에이전트 — kill_switch 제어
  defp support_children(kill_switch_on) do
    if kill_switch_on do
      [
        Darwin.V2.FeedbackLoop,
        Darwin.V2.KeywordEvolver,
        Darwin.V2.ResearchMonitor,
        Darwin.V2.MetaReview
      ]
    else
      []
    end
  end

  # Shadow Mode + TelegramBridge 선택적 기동
  # TelegramBridge는 항상, ShadowRunner는 DARWIN_SHADOW_MODE=true 시에만 기동
  defp maybe_shadow_children do
    telegram = [Darwin.V2.TelegramBridge]

    shadow =
      if Darwin.V2.ShadowRunner.enabled?() do
        Logger.info("[다윈V2] Shadow Mode 활성 — V1 vs V2 병행 비교 기동")
        [Darwin.V2.ShadowRunner]
      else
        []
      end

    telegram ++ shadow
  end

  # HTTP 서버 선택적 기동 — 포트 사용 가능할 때만
  defp maybe_http_children do
    port = Application.get_env(:darwin, :http_port, 8180)
    mcp_enabled = Application.get_env(:darwin, :mcp_enabled, false)

    if check_port_available(port) do
      router = if mcp_enabled, do: Darwin.V2.HTTP.MCPRouter, else: Darwin.V2.HTTP.Router
      Logger.info("[다윈V2] HTTP 서버 기동 — 포트 #{port}, MCP=#{mcp_enabled}")
      [{Bandit, plug: router, port: port, scheme: :http}]
    else
      Logger.warning("[다윈V2] 포트 #{port} 사용 불가 — HTTP 서버 생략")
      []
    end
  end

  # 포트 가용성 확인
  defp check_port_available(port) do
    case :gen_tcp.listen(port, [:binary, {:reuseaddr, true}]) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        true

      {:error, _} ->
        false
    end
  end
end
