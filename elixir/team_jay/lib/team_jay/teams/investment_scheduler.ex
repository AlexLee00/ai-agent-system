defmodule TeamJay.Teams.InvestmentScheduler do
  @moduledoc """
  투자팀 구 PortAgent 스케줄 호환용 헬퍼.

  Luna 45→8 전환 이후 wall-clock 실행은 launchd의 runtime-autopilot,
  ops-scheduler, marketdata-mcp, commander가 전담한다. 이 모듈은 과거
  `markets/*` 수동 트리거가 재도입되지 않도록 명시적으로 no-op을 반환한다.
  """

  defp retired(name) do
    {:error, {:retired_luna_port_agent_schedule, name}}
  end

  # ────────────────────────────────────────────────────────────────
  # 기존 (변경 없음)
  # ────────────────────────────────────────────────────────────────

  def run_prescreen_domestic, do: retired(:prescreen_domestic)
  def run_prescreen_overseas, do: retired(:prescreen_overseas)

  def run_market_alert_domestic_open, do: retired(:market_alert_domestic_open)
  def run_market_alert_domestic_close, do: retired(:market_alert_domestic_close)
  def run_market_alert_overseas_open, do: retired(:market_alert_overseas_open)
  def run_market_alert_overseas_close, do: retired(:market_alert_overseas_close)
  def run_market_alert_crypto_daily, do: retired(:market_alert_crypto_daily)

  def run_reporter, do: retired(:reporter)
  def run_daily_feedback, do: retired(:daily_feedback)

  # ────────────────────────────────────────────────────────────────
  # 신규 — CODEX_LUNA_OPS_TRANSITION
  # ────────────────────────────────────────────────────────────────

  @doc "스카우트 (06:30 KST, 18:30 KST)"
  def run_scout, do: retired(:scout)

  @doc "국내장 30분 주기 (09:00~15:30 KST)"
  def run_domestic, do: retired(:domestic)

  @doc "국내장 검증 30분 주기"
  def run_domestic_validation, do: retired(:domestic_validation)

  @doc "해외장 30분 주기 (22:30~05:00 KST)"
  def run_overseas, do: retired(:overseas)

  @doc "해외장 검증 30분 주기"
  def run_overseas_validation, do: retired(:overseas_validation)
end
