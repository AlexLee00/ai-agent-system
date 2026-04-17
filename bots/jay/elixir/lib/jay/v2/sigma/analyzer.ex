defmodule Jay.V2.Sigma.Analyzer do
  @moduledoc """
  시그마 편성 분석기 (sigma-analyzer.ts Elixir 포트).
  편성 + 어제 메트릭 기반으로 팀별 피드백 컨텍스트 생성.
  """

  require Logger
  alias Jay.V2.TeamConnector

  @type analyst_rec :: %{
    team: atom(),
    primary_analyst: atom(),
    recommendation: String.t(),
    metric: map() | nil
  }

  @doc "편성 → 팀별 분석 리스트"
  def analyze(formation) do
    formation[:target_teams]
    |> Enum.map(fn team ->
      metric = TeamConnector.collect(team)
      analyst = pick_primary_analyst(team, metric, formation)
      rec = build_recommendation(team, metric, analyst)
      %{team: team, primary_analyst: analyst, recommendation: rec, metric: metric}
    end)
  end

  # ────────────────────────────────────────────────────────────────
  # 분석가 선택 + 권고안 생성
  # ────────────────────────────────────────────────────────────────

  defp pick_primary_analyst(team, metric, formation) do
    low_score_teams = Enum.map(
      formation[:low_score_teams] || [],
      fn {t, _} -> t end
    )

    cond do
      team in low_score_teams -> :hawk         # 저성과 → 리스크 점검
      degraded?(metric) -> :hawk               # 지표 저하 → 리스크
      thriving?(metric) -> :dove               # 성장 중 → 확대
      trending?(metric) -> :owl                # 추세 변화 → 트렌드 감시
      true -> :pipe                            # 기본 → 파이프 분석
    end
  end

  defp degraded?(%{failed: f}) when f >= 3, do: true
  defp degraded?(%{unhealthy_count: n}) when n >= 2, do: true
  defp degraded?(%{pnl_usdt_7d: pnl}) when is_number(pnl) and pnl < -50, do: true
  defp degraded?(_), do: false

  defp thriving?(%{published_7d: n}) when n >= 5, do: true
  defp thriving?(%{trades_7d: n, pnl_usdt_7d: pnl}) when n >= 5 and is_number(pnl) and pnl > 0, do: true
  defp thriving?(_), do: false

  defp trending?(%{market_regime: r}) when r in ["volatile", "bull"], do: true
  defp trending?(_), do: false

  defp build_recommendation(team, metric, :hawk) do
    "리스크 관점에서 #{team}의 병목/실패 패턴을 우선 점검하세요. #{metric_hint(metric)}"
  end

  defp build_recommendation(team, metric, :dove) do
    "성공 패턴이 보이는 #{team}의 강점을 확대하고 재사용 가능한 운영 규칙을 추출하세요. #{metric_hint(metric)}"
  end

  defp build_recommendation(team, metric, :owl) do
    "#{team}의 주간 추세를 기준으로 구조적 변화 여부를 점검하세요. #{metric_hint(metric)}"
  end

  defp build_recommendation(team, metric, _analyst) do
    "#{team}의 핵심 지표를 일일 기준으로 추적하고 개선점을 정리하세요. #{metric_hint(metric)}"
  end

  defp metric_hint(nil), do: ""
  defp metric_hint(%{metric_type: :trading_ops, trades_7d: t, pnl_usdt_7d: pnl}) do
    "(7일 거래 #{t}건, PnL #{pnl})"
  end
  defp metric_hint(%{metric_type: :content_ops, published_7d: p}) do
    "(7일 발행 #{p}건)"
  end
  defp metric_hint(%{metric_type: :reservation_ops, completed: c, failed: f}) do
    "(완료 #{c}건, 실패 #{f}건)"
  end
  defp metric_hint(_), do: ""
end
