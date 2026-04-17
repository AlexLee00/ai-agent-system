defmodule TeamJay.Teams.InvestmentSupervisor do
  use Supervisor

  @moduledoc """
  루나팀 PortAgent 전환 — CODEX_LUNA_OPS_TRANSITION.

  환경 변수 INVESTMENT_ELIXIR_ENABLED=true 시 활성화.
  launchd와 병렬 운영 가능 (리허설용). 전환 완료 후 launchd 비활성화.

  에이전트 분류:
  - interval_agents: PortAgent가 자체 타이머로 반복 실행
  - calendar_agents: Quantum Scheduler가 PortAgent.run(:name)으로 트리거
  """

  # ────────────────────────────────────────────────────────────────
  # 에이전트 정의
  # ────────────────────────────────────────────────────────────────

  # 자체 인터벌 에이전트 (PortAgent 내부 타이머)
  @interval_agents [
    # KeepAlive 데몬 — luna-commander.cjs
    %{name: :commander,
      script: "bots/investment/luna-commander.cjs",
      runner: :node,
      schedule: :once},

    # 5분 암호화폐 매매 (LIVE)
    %{name: :crypto,
      script: "bots/investment/markets/crypto.ts",
      runner: :node,
      schedule: {:interval, 300_000}},

    # 15분 암호화폐 매매 (VALIDATION)
    %{name: :crypto_validation,
      script: "NODE_ENV=production INVESTMENT_TRADE_MODE=validation node bots/investment/markets/crypto.ts",
      runner: {:shell, "/bin/zsh"},
      schedule: {:interval, 900_000}},

    # 10분 헬스체크
    %{name: :health_check,
      script: "bots/investment/scripts/health-check.ts",
      runner: :node,
      schedule: {:interval, 600_000}},

    # 10분 미실현 손익 업데이트
    %{name: :unrealized_pnl,
      script: "bots/investment/scripts/update-unrealized-pnl.ts",
      runner: :node,
      schedule: {:interval, 600_000}},

    # 6시간 기술지표 스크리닝 (Argos)
    %{name: :argos,
      script: "bots/investment/team/argos.ts",
      runner: :node,
      schedule: {:interval, 21_600_000}},
  ]

  # 달력 기반 에이전트 (schedule: nil — Quantum이 PortAgent.run(:name) 트리거)
  @calendar_agents [
    # 국내장 (09:00~15:30 KST, 30분)
    %{name: :domestic,
      script: "bots/investment/markets/domestic.ts",
      runner: :node},

    # 국내장 검증
    %{name: :domestic_validation,
      script: "NODE_ENV=production INVESTMENT_TRADE_MODE=validation node bots/investment/markets/domestic.ts",
      runner: {:shell, "/bin/zsh"}},

    # 해외장 (22:30~05:00 KST, 30분)
    %{name: :overseas,
      script: "bots/investment/markets/overseas.ts",
      runner: :node},

    # 해외장 검증
    %{name: :overseas_validation,
      script: "NODE_ENV=production INVESTMENT_TRADE_MODE=validation node bots/investment/markets/overseas.ts",
      runner: {:shell, "/bin/zsh"}},

    # 국내 사전 스크리닝 (08:00 KST)
    %{name: :prescreen_domestic,
      script: "bots/investment/scripts/pre-market-screen.ts domestic",
      runner: :node},

    # 해외 사전 스크리닝 (21:00 KST)
    %{name: :prescreen_overseas,
      script: "bots/investment/scripts/pre-market-screen.ts overseas",
      runner: :node},

    # 리포터 (08:00 KST)
    %{name: :reporter,
      script: "bots/investment/team/reporter.ts --telegram",
      runner: :node},

    # 스카우트 (06:30, 18:30 KST)
    %{name: :scout,
      script: "bots/investment/team/scout.ts",
      runner: :node},

    # 시장 알림
    %{name: :market_alert_domestic_open,
      script: "bots/investment/scripts/market-alert.ts --market=domestic --event=open",
      runner: :node},
    %{name: :market_alert_domestic_close,
      script: "bots/investment/scripts/market-alert.ts --market=domestic --event=close",
      runner: :node},
    %{name: :market_alert_overseas_open,
      script: "bots/investment/scripts/market-alert.ts --market=overseas --event=open",
      runner: :node},
    %{name: :market_alert_overseas_close,
      script: "bots/investment/scripts/market-alert.ts --market=overseas --event=close",
      runner: :node},
    %{name: :market_alert_crypto_daily,
      script: "bots/investment/scripts/market-alert.ts --market=crypto --event=daily",
      runner: :node},
  ]

  # ────────────────────────────────────────────────────────────────
  # Supervisor
  # ────────────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = if enabled?() do
      interval_children() ++ calendar_children()
    else
      []
    end

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end

  # ────────────────────────────────────────────────────────────────
  # 헬퍼
  # ────────────────────────────────────────────────────────────────

  defp enabled? do
    System.get_env("INVESTMENT_ELIXIR_ENABLED") == "true"
  end

  defp interval_children do
    Enum.map(@interval_agents, fn agent ->
      {TeamJay.Agents.PortAgent,
       name: agent.name,
       team: :investment,
       script: agent.script,
       runner: agent[:runner] || :node,
       schedule: agent.schedule}
    end)
  end

  defp calendar_children do
    Enum.map(@calendar_agents, fn agent ->
      {TeamJay.Agents.PortAgent,
       name: agent.name,
       team: :investment,
       script: agent.script,
       runner: agent[:runner] || :node,
       schedule: nil}
    end)
  end

  @doc "활성 에이전트 이름 목록"
  def agent_names do
    (@interval_agents ++ @calendar_agents)
    |> Enum.map(& &1.name)
  end

  @doc "ownership manifest와 대조할 Elixir-managed launch labels"
  def agent_labels do
    [
      "ai.investment.commander",
      "ai.investment.argos",
      "ai.investment.reporter",
      "ai.investment.health-check",
      "ai.investment.unrealized-pnl",
      "ai.investment.prescreen-domestic",
      "ai.investment.prescreen-overseas",
      "ai.investment.market-alert-domestic-open",
      "ai.investment.market-alert-domestic-close",
      "ai.investment.market-alert-overseas-open",
      "ai.investment.market-alert-overseas-close",
      "ai.investment.market-alert-crypto-daily"
    ]
  end
end
