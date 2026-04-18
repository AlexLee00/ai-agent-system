defmodule TeamJay.Ska.Skill.TriggerRecovery do
  @moduledoc """
  실패 유형별 복구 루틴 트리거 스킬 — 모든 에이전트 공통.

  입력: %{agent: :andy, failure_type: :session_expired, context: %{}}
  출력: {:ok, %{recovery_triggered: true, strategy: :naver_relogin}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :trigger_recovery,
      domain: :common,
      version: "1.0",
      description: "실패 유형별 복구 루틴 트리거",
      input_schema: %{agent: :atom, failure_type: :atom, context: :map},
      output_schema: %{recovery_triggered: :boolean, strategy: :atom}
    }
  end

  @impl true
  def run(params, _context) do
    strategy = decide_strategy(params[:agent], params[:failure_type])
    execute_recovery(strategy, params)
  end

  defp decide_strategy(:andy, :session_expired), do: :naver_relogin
  defp decide_strategy(:andy, :parse_failed), do: :selector_rollback
  defp decide_strategy(:andy, :selector_failed), do: :selector_rollback
  defp decide_strategy(:jimmy, :kiosk_frozen), do: :kiosk_restart
  defp decide_strategy(:jimmy, :session_expired), do: :kiosk_reconnect
  defp decide_strategy(:pickko, :db_disconnect), do: :pickko_reconnect
  defp decide_strategy(:pickko, :session_expired), do: :pickko_reconnect
  defp decide_strategy(_, :network_error), do: :backoff_retry
  defp decide_strategy(_, _), do: :escalate_to_master

  defp execute_recovery(:naver_relogin, _params) do
    TeamJay.Ska.Naver.NaverRecovery.refresh_session()
    {:ok, %{recovery_triggered: true, strategy: :naver_relogin}}
  end

  defp execute_recovery(:selector_rollback, params) do
    agent = params[:agent]
    TeamJay.Ska.SelectorManager.rollback_to_last_working(agent)
    {:ok, %{recovery_triggered: true, strategy: :selector_rollback}}
  end

  defp execute_recovery(:kiosk_restart, _params) do
    TeamJay.Ska.Kiosk.KioskAgent.restart_session()
    {:ok, %{recovery_triggered: true, strategy: :kiosk_restart}}
  end

  defp execute_recovery(:kiosk_reconnect, _params) do
    TeamJay.Ska.Kiosk.KioskAgent.reconnect()
    {:ok, %{recovery_triggered: true, strategy: :kiosk_reconnect}}
  end

  defp execute_recovery(:pickko_reconnect, _params) do
    TeamJay.Ska.Pickko.PickkoMonitor.reconnect()
    {:ok, %{recovery_triggered: true, strategy: :pickko_reconnect}}
  end

  defp execute_recovery(:backoff_retry, params) do
    agent = params[:agent]
    TeamJay.Ska.FailureTracker.schedule_retry(agent)
    {:ok, %{recovery_triggered: true, strategy: :backoff_retry}}
  end

  defp execute_recovery(:escalate_to_master, _params) do
    TeamJay.Telegram.send_urgent("🚨 복구 전략 미정의 — 마스터 수동 개입 필요")
    {:ok, %{recovery_triggered: false, strategy: :escalate_to_master}}
  end
end
