defmodule Luna.V2.Validation.PromotionGate do
  @moduledoc """
  Validation Stage 5 — 승격/유지/강등 판정 게이트.

  backtest + walk_forward + shadow + validation_live 결과를
  단일 verdict (:promote | :hold | :demote)로 통합.

  승격 기준 (모두 충족):
    - backtest sharpe ≥ 1.5
    - backtest hit_rate ≥ 0.55
    - backtest max_dd > -0.15 (15% 이내)
    - walk_forward pass == true
    - shadow runs ≥ 10 (미충족 시 hold)

  강등 기준 (하나라도 충족):
    - backtest sharpe < 0.5
    - backtest max_dd < -0.25 (25% 초과 손실)
  """

  @promote_sharpe    1.5
  @promote_hit_rate  0.55
  @promote_max_dd    -0.15
  @demote_sharpe     0.5
  @demote_max_dd     -0.25

  @doc """
  stage 결과 리스트를 받아 verdict 반환.

  반환: {:ok, %{verdict: :promote | :hold | :demote, sharpe, hit_rate, max_dd, reasons}}
  """
  def decide(results) when is_list(results) do
    bt = find(results, :backtest)
    wf = find(results, :walk_forward)
    sh = find(results, :shadow)

    sharpe   = bt[:sharpe]    || 0.0
    hit_rate = bt[:hit_rate]  || 0.0
    max_dd   = bt[:max_dd]    || 0.0
    wf_pass  = wf[:pass]      || false
    sh_runs  = sh[:runs]      || 0

    {verdict, reasons} = compute_verdict(sharpe, hit_rate, max_dd, wf_pass, sh_runs)

    {:ok, %{
      verdict:  verdict,
      sharpe:   sharpe,
      hit_rate: hit_rate,
      max_dd:   max_dd,
      reasons:  reasons
    }}
  end

  defp compute_verdict(sharpe, _hit_rate, max_dd, _wf_pass, _sh_runs)
       when sharpe < @demote_sharpe or max_dd < @demote_max_dd do
    reasons = []
    reasons = if sharpe < @demote_sharpe, do: ["sharpe #{Float.round(sharpe, 2)} < #{@demote_sharpe}" | reasons], else: reasons
    reasons = if max_dd < @demote_max_dd, do: ["max_dd #{Float.round(max_dd * 100, 1)}% < #{@demote_max_dd * 100}%" | reasons], else: reasons
    {:demote, reasons}
  end

  defp compute_verdict(sharpe, hit_rate, max_dd, wf_pass, sh_runs)
       when sharpe >= @promote_sharpe and hit_rate >= @promote_hit_rate and
            max_dd > @promote_max_dd and wf_pass == true and sh_runs >= 10 do
    {:promote, ["sharpe #{Float.round(sharpe, 2)}", "hit_rate #{Float.round(hit_rate * 100, 1)}%",
                "walk_forward pass", "shadow #{sh_runs}회"]}
  end

  defp compute_verdict(sharpe, hit_rate, _max_dd, wf_pass, sh_runs) do
    reasons = []
    reasons = if sharpe < @promote_sharpe, do: ["sharpe #{Float.round(sharpe, 2)} < #{@promote_sharpe}" | reasons], else: reasons
    reasons = if hit_rate < @promote_hit_rate, do: ["hit_rate #{Float.round(hit_rate * 100, 1)}% < #{@promote_hit_rate * 100}%" | reasons], else: reasons
    reasons = if not wf_pass, do: ["walk_forward fail" | reasons], else: reasons
    reasons = if sh_runs < 10, do: ["shadow #{sh_runs}회 < 10회" | reasons], else: reasons
    {:hold, reasons}
  end

  defp find(results, type), do: Enum.find(results, &(&1[:type] == type)) || %{}
end
