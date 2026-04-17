defmodule Sigma.V2.Skill.CausalCheck do
  @moduledoc """
  CausalCheck — 상관관계 vs 인과관계 구분 검증.
  TS packages/core/lib/skills/sigma/causal-check.ts 1:1 포팅.
  """

  use Jido.Action,
    name: "sigma_v2_causal_check",
    description: "Check causal validity of proposed feedback before application",
    schema: Zoi.object(%{
      claim: Zoi.default(Zoi.string(), ""),
      correlation: Zoi.default(Zoi.float(), 0.0),
      controls: Zoi.default(Zoi.list(Zoi.string()), []),
      confounders: Zoi.default(Zoi.list(Zoi.string()), []),
      sample_size: Zoi.default(Zoi.integer(), 0)
    })

  @impl Jido.Action
  def run(params, _ctx) do
    claim = String.trim(Map.get(params, :claim, "") || "")
    correlation = Map.get(params, :correlation, 0.0) || 0.0
    controls = Enum.filter(Map.get(params, :controls, []) || [], &(&1 != nil and &1 != ""))
    confounders = Enum.filter(Map.get(params, :confounders, []) || [], &(&1 != nil and &1 != ""))
    sample_size = Map.get(params, :sample_size, 0) || 0

    {flags, recommendations, risk_score} = evaluate(claim, correlation, controls, confounders, sample_size)

    causal_risk =
      cond do
        risk_score >= 6 -> "high"
        risk_score >= 4 -> "medium"
        true -> "low"
      end

    {:ok, %{
      causal_risk: causal_risk,
      flags: flags,
      recommendations: Enum.uniq(recommendations)
    }}
  end

  defp evaluate(claim, correlation, controls, confounders, sample_size) do
    initial = {[], [], 2.0}

    initial
    |> check_missing_claim(claim)
    |> check_correlation_without_controls(correlation, controls)
    |> check_missing_confounders(confounders)
    |> check_uncontrolled_confounders(confounders, controls)
    |> check_small_sample(sample_size)
  end

  defp check_missing_claim({flags, recs, score}, "") do
    {flags ++ ["missing causal claim"], recs, score + 2.5}
  end
  defp check_missing_claim(acc, _claim), do: acc

  defp check_correlation_without_controls({flags, recs, score}, correlation, controls)
    when abs(correlation) >= 0.5 and controls == [] do
    {
      flags ++ ["strong correlation without controls"],
      recs ++ ["add baseline controls before causal interpretation"],
      score + 2.0
    }
  end
  defp check_correlation_without_controls(acc, _corr, _controls), do: acc

  defp check_missing_confounders({flags, recs, score}, []) do
    {
      flags ++ ["missing confounder review"],
      recs ++ ["review potential confounders such as timing, topic mix, or channel changes"],
      score + 1.8
    }
  end
  defp check_missing_confounders(acc, _), do: acc

  defp check_uncontrolled_confounders({flags, recs, score}, confounders, controls)
    when confounders != [] and controls == [] do
    {
      flags ++ ["known confounders with no controls"],
      recs ++ ["add controls to account for identified confounders"],
      score + 1.5
    }
  end
  defp check_uncontrolled_confounders(acc, _confounders, _controls), do: acc

  defp check_small_sample({flags, recs, score}, sample_size)
    when sample_size > 0 and sample_size < 300 do
    {
      flags ++ ["small sample for causal claim"],
      recs ++ ["increase sample size before causal conclusion"],
      score + 1.3
    }
  end
  defp check_small_sample(acc, _), do: acc
end
