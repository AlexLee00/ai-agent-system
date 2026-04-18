defmodule Luna.V2.Commander do
  @moduledoc """
  Luna V2 Commander — Jido.AI.Agent 기반 투자팀 오케스트레이터.

  역할: 11개 에이전트(TS 레이어)의 신호를 받아 자율 판단·조율.
    - MAPE-K 루프 트리거
    - 시장 레짐 감지 → 연구 깊이 조정
    - 포트폴리오 맥락 통합
    - 리스크 한도 실시간 점검
    - JayBus 이벤트 발행 (investment.signal.*)

  V2 run_cycle/2: Research → Screening → PolicyGate → Rationale → Dispatch → Review

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

  alias Luna.V2.Skill.{
    ResearchAggregator,
    CandidateScreening,
    PolicyGate,
    DecisionRationale,
    ExecutionDispatcher,
    ReviewFeedback
  }

  @doc """
  시장별 자율 사이클 실행 (MAPE-K Analyze→Plan→Execute).

  market: :crypto | :domestic | :overseas
  opts:   [shadow: true] — shadow 모드 시 ExecutionDispatcher 스킵
  """
  def run_cycle(market, opts \\ []) do
    shadow? = Keyword.get(opts, :shadow, false)
    Logger.info("[루나V2/Commander] run_cycle 시작 — market=#{market} shadow=#{shadow?}")

    with {:ok, %{research: research}}     <- ResearchAggregator.run(%{market: market}, %{}),
         {:ok, %{candidates: candidates}} <- CandidateScreening.run(%{research: research, market: market}, %{}),
         {:ok, %{approved: approved}}     <- PolicyGate.run(%{candidates: candidates, market: market}, %{}),
         {:ok, %{orders: orders}}         <- DecisionRationale.run(%{approved: approved, market: market}, %{}) do

      if shadow? do
        log_shadow_cycle(market, orders)
        {:ok, %{shadow: true, orders: orders, market: market}}
      else
        with {:ok, %{executed: executed}} <- ExecutionDispatcher.run(%{orders: orders, market: market}, %{}),
             {:ok, _}                     <- ReviewFeedback.run(%{executed: executed}, %{}) do
          broadcast_cycle_complete(market, executed)
          {:ok, %{executed: executed, market: market}}
        end
      end
    else
      {:error, reason} ->
        Logger.error("[루나V2/Commander] 사이클 실패 — market=#{market}: #{inspect(reason)}")
        {:error, reason}
    end
  end

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

  defp broadcast_cycle_complete(market, executed) do
    Phoenix.PubSub.broadcast(
      Luna.V2.PubSub,
      "luna:mapek_events",
      {:cycle_complete, %{market: market, executed_count: length(executed), timestamp: DateTime.utc_now()}}
    )
  end

  defp log_shadow_cycle(market, orders) do
    query = """
    INSERT INTO luna_v2_shadow_comparison (market, orders_json, created_at)
    VALUES ($1, $2, NOW())
    """
    Jay.Core.Repo.query(query, [to_string(market), Jason.encode!(orders)])
  rescue
    e -> Logger.warning("[루나V2/Commander] Shadow 로그 실패: #{inspect(e)}")
  end
end
