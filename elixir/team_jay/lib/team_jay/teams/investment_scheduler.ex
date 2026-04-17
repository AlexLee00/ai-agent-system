defmodule TeamJay.Teams.InvestmentScheduler do
  @moduledoc """
  투자팀 calendar 기반 작업을 Quantum에서 트리거하는 헬퍼.

  CODEX_LUNA_OPS_TRANSITION: launchd 전환 대상 스케줄 전체 커버.
  주의: PortAgent가 등록된 경우에만 run()이 유효. InvestmentSupervisor 비활성 시 무시됨.
  시장 휴장/주말 판단은 각 스크립트 내부 가드에서 처리.
  """

  alias Jay.Core.Agents.PortAgent
  alias TeamJay.Investment.Feedback.Daily, as: DailyFeedback

  # ────────────────────────────────────────────────────────────────
  # 기존 (변경 없음)
  # ────────────────────────────────────────────────────────────────

  def run_prescreen_domestic, do: PortAgent.run(:prescreen_domestic)
  def run_prescreen_overseas, do: PortAgent.run(:prescreen_overseas)

  def run_market_alert_domestic_open, do: PortAgent.run(:market_alert_domestic_open)
  def run_market_alert_domestic_close, do: PortAgent.run(:market_alert_domestic_close)
  def run_market_alert_overseas_open, do: PortAgent.run(:market_alert_overseas_open)
  def run_market_alert_overseas_close, do: PortAgent.run(:market_alert_overseas_close)
  def run_market_alert_crypto_daily, do: PortAgent.run(:market_alert_crypto_daily)

  def run_reporter, do: PortAgent.run(:reporter)
  def run_daily_feedback, do: DailyFeedback.run()

  # ────────────────────────────────────────────────────────────────
  # 신규 — CODEX_LUNA_OPS_TRANSITION
  # ────────────────────────────────────────────────────────────────

  @doc "스카우트 (06:30 KST, 18:30 KST)"
  def run_scout, do: PortAgent.run(:scout)

  @doc "국내장 30분 주기 (09:00~15:30 KST)"
  def run_domestic, do: PortAgent.run(:domestic)

  @doc "국내장 검증 30분 주기"
  def run_domestic_validation, do: PortAgent.run(:domestic_validation)

  @doc "해외장 30분 주기 (22:30~05:00 KST)"
  def run_overseas, do: PortAgent.run(:overseas)

  @doc "해외장 검증 30분 주기"
  def run_overseas_validation, do: PortAgent.run(:overseas_validation)
end
