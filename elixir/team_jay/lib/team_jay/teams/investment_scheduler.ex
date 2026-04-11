defmodule TeamJay.Teams.InvestmentScheduler do
  @moduledoc """
  투자팀 calendar 기반 작업을 Quantum에서 트리거하는 헬퍼.

  주의:
  - 이 모듈은 PortAgent를 직접 실행만 한다.
  - 시장 휴장/주말 판단은 각 스크립트 내부 가드 또는 후속 Scheduler 고도화에서 처리한다.
  """

  alias TeamJay.Agents.PortAgent

  def run_prescreen_domestic, do: PortAgent.run(:prescreen_domestic)
  def run_prescreen_overseas, do: PortAgent.run(:prescreen_overseas)

  def run_market_alert_domestic_open, do: PortAgent.run(:market_alert_domestic_open)
  def run_market_alert_domestic_close, do: PortAgent.run(:market_alert_domestic_close)
  def run_market_alert_overseas_open, do: PortAgent.run(:market_alert_overseas_open)
  def run_market_alert_overseas_close, do: PortAgent.run(:market_alert_overseas_close)
  def run_market_alert_crypto_daily, do: PortAgent.run(:market_alert_crypto_daily)

  def run_reporter, do: PortAgent.run(:reporter)
  def run_daily_feedback, do: PortAgent.run(:daily_feedback)
end
