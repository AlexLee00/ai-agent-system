defmodule Luna.V2.Commander do
  @moduledoc """
  Luna V2 Commander — Jido.AI.Agent 기반 투자팀 오케스트레이터.

  역할: 11개 에이전트(TS 레이어)의 신호를 받아 자율 판단·조율.
    - MAPE-K 루프 트리거
    - 시장 레짐 감지 → 연구 깊이 조정
    - 포트폴리오 맥락 통합
    - 리스크 한도 실시간 점검
    - JayBus 이벤트 발행 (investment.signal.*)

  Tools(Skills):
    - MarketRegimeDetector  : 현재 레짐 분류 (trending_bull/bear/ranging/volatile)
    - PortfolioMonitor      : 포지션 현황 + 손익 요약
    - RiskGovernor          : 실시간 리스크 한도 점검
    - SignalAggregator       : 멀티 에이전트 신호 통합 점수
    - FeedbackReporter      : MAPE-K Knowledge 저장 + 텔레그램 브리핑

  Hub LLM 라우팅: LUNA_LLM_HUB_ENABLED=true 시 Hub /llm/call 경유.
  """

  use Jido.AI.Agent,
    name:        "luna_commander",
    description: "루나팀 자율 투자 오케스트레이터 — 시장 레짐 감지·포트폴리오 조율·리스크 거버넌스",
    model:       :smart,
    tools: [
      Luna.V2.Skill.MarketRegimeDetector,
      Luna.V2.Skill.PortfolioMonitor,
      Luna.V2.Skill.RiskGovernor,
      Luna.V2.Skill.SignalAggregator,
      Luna.V2.Skill.FeedbackReporter,
    ]

  require Logger

  @doc "투자 신호 평가 요청 파라미터를 브로드캐스트 (MAPE-K Monitor가 처리)"
  def evaluate_signal(signal_params) do
    Phoenix.PubSub.broadcast(
      Luna.V2.PubSub,
      "luna:mapek_events",
      {:evaluate_signal, signal_params}
    )
  end

  @doc "일일 포트폴리오 브리핑 트리거"
  def daily_briefing do
    Phoenix.PubSub.broadcast(
      Luna.V2.PubSub,
      "luna:mapek_events",
      {:daily_briefing, %{requested_at: DateTime.utc_now()}}
    )
  end
end
