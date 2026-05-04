defmodule TeamJay.Teams.InvestmentSupervisor do
  use Supervisor

  @moduledoc """
  루나팀 PortAgent 전환 — CODEX_LUNA_OPS_TRANSITION.

  현재 Luna 45→8 전환 후 wall-clock 실행의 canonical owner는 launchd
  (`runtime-autopilot`, `ops-scheduler`, `marketdata-mcp`, `commander`)다.
  이 Supervisor는 네이티브 Elixir 투자 모듈과 command bus만 유지하고,
  구 `markets/*` PortAgent 스케줄은 중복 실행 방지를 위해 등록하지 않는다.

  에이전트 분류:
  - interval_agents: PortAgent가 자체 타이머로 반복 실행
  - calendar_agents: Quantum Scheduler가 PortAgent.run(:name)으로 트리거
  """

  # ────────────────────────────────────────────────────────────────
  # 에이전트 정의
  # ────────────────────────────────────────────────────────────────

  # launchd가 canonical owner인 주기/상시 서비스는 PortAgent에서 중복 실행하지 않는다.
  @interval_agents []

  @calendar_agents []

  # ────────────────────────────────────────────────────────────────
  # Supervisor
  # ────────────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      if enabled?() do
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
      {Jay.Core.Agents.PortAgent,
       name: agent.name,
       team: :investment,
       script: agent.script,
       runner: agent[:runner] || :tsx,
       schedule: agent.schedule}
    end)
  end

  defp calendar_children do
    Enum.map(@calendar_agents, fn agent ->
      {Jay.Core.Agents.PortAgent,
       name: agent.name,
       team: :investment,
       script: agent.script,
       runner: agent[:runner] || :tsx,
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
    []
  end
end
