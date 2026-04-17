defmodule Jay.V2.DecisionEngine do
  @moduledoc """
  Progressive Autonomy — 팀 간 연동 판단 엔진.
  ElixirData 패턴: ALLOW / MODIFY / ESCALATE / BLOCK
  """

  require Logger
  alias Jay.V2.Topics

  @type decision :: :allow | :modify | :escalate | :block

  @doc """
  팀 간 파이프라인 트리거 여부 판단.
  모든 판단은 EventLake에 기록됨.
  """
  def evaluate(event_type, context) do
    decision = do_evaluate(event_type, context)
    Topics.broadcast_decision(decision, Map.put(context, :event_type, event_type))
    record_decision(event_type, decision, context)
    decision
  end

  # ────────────────────────────────────────────────────────────────
  # 크로스 파이프라인 판단 규칙
  # ────────────────────────────────────────────────────────────────

  # 스카 매출 하락 → 블로팀 프로모션
  defp do_evaluate(:ska_revenue_drop, %{drop_pct: drop_pct}) do
    cond do
      drop_pct >= 30 -> :escalate   # 30%+ → 마스터 알림
      drop_pct >= 15 -> :allow      # 15~30% → 자동 프로모션 요청
      true -> :block                # 15% 미만 → 무시
    end
  end

  # 루나 시장 급변 → 블로 투자 콘텐츠
  defp do_evaluate(:luna_market_shock, %{regime: regime}) do
    case regime do
      "bull" -> :allow              # 상승장 → 자동 투자 콘텐츠
      "bear" -> :allow              # 하락장 → 자동 투자 콘텐츠
      "volatile" -> :allow          # 변동 → 자동 콘텐츠
      "crisis" -> :escalate         # 위기 → 마스터 알림
      _ -> :modify                  # 불명확 → 컨텍스트 보강 후 실행
    end
  end

  # 클로드 시스템 위험 → 전체 작업 축소
  defp do_evaluate(:system_risk, %{risk_level: level}) do
    cond do
      level >= 9 -> :block          # 긴급 차단
      level >= 7 -> :escalate       # 마스터 긴급 알림
      level >= 5 -> :allow          # 자동 워크로드 축소
      true -> :modify               # 모니터링 강화만
    end
  end

  # 미분류 이벤트 → 기본 allow (규칙 없으면 통과)
  defp do_evaluate(_event_type, _context), do: :allow

  # ────────────────────────────────────────────────────────────────
  # 판단 결과 처리
  # ────────────────────────────────────────────────────────────────

  defp record_decision(event_type, decision, context) do
    Jay.Core.EventLake.record(%{
      source: "jay.decision_engine",
      event_type: "decision.#{decision}",
      severity: decision_severity(decision),
      payload: %{
        event_type: event_type,
        decision: decision,
        context: context
      }
    })
  rescue
    _ -> :ok
  end

  defp decision_severity(:block), do: "warning"
  defp decision_severity(:escalate), do: "info"
  defp decision_severity(:modify), do: "debug"
  defp decision_severity(:allow), do: "debug"
end
