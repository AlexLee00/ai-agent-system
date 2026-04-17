defmodule Sigma.V2.Skill.ExperimentDesign do
  @moduledoc """
  ExperimentDesign — A/B 실험 설계 및 통계적 유의성 계획.
  TS packages/core/lib/skills/sigma/experiment-design.ts 1:1 포팅.
  """

  use Jido.Action,
    name: "sigma_v2_experiment_design",
    description: "Design A/B experiments for proposed feedback validation",
    schema: Zoi.object(%{
      hypothesis: Zoi.default(Zoi.string(), ""),
      metric: Zoi.default(Zoi.string(), ""),
      baseline_defined: Zoi.default(Zoi.boolean(), false),
      variant_count: Zoi.default(Zoi.integer(), 0),
      sample_size: Zoi.default(Zoi.integer(), 0),
      has_guardrail_metric: Zoi.default(Zoi.boolean(), false)
    })

  @impl Jido.Action
  def run(params, _ctx) do
    hypothesis = String.trim(params.hypothesis || "")
    metric = String.trim(params.metric || "")
    baseline_defined = params.baseline_defined || false
    variant_count = params.variant_count || 0
    sample_size = params.sample_size || 0
    has_guardrail_metric = params.has_guardrail_metric || false

    {issues, recommendations, score} =
      {[], [], 10.0}
      |> check_hypothesis(hypothesis)
      |> check_metric(metric)
      |> check_baseline(baseline_defined)
      |> check_variants(variant_count)
      |> check_sample_size(sample_size)
      |> check_guardrail(has_guardrail_metric)

    final_score = max(0.0, Float.round(score, 1))

    {:ok, %{
      passed: issues == [],
      design_score: final_score,
      issues: issues,
      recommendations: recommendations
    }}
  end

  defp check_hypothesis({issues, recs, score}, "") do
    {issues ++ ["missing hypothesis"], recs, score - 2.5}
  end
  defp check_hypothesis(acc, _), do: acc

  defp check_metric({issues, recs, score}, "") do
    {issues ++ ["missing primary metric"], recs, score - 2.0}
  end
  defp check_metric(acc, _), do: acc

  defp check_baseline({issues, recs, score}, false) do
    {
      issues ++ ["missing baseline definition"],
      recs ++ ["define the current control or historical baseline"],
      score - 1.8
    }
  end
  defp check_baseline(acc, _), do: acc

  defp check_variants({issues, recs, score}, count) when count < 2 do
    {
      issues ++ ["insufficient variants"],
      recs ++ ["add at least control and one treatment"],
      score - 1.4
    }
  end
  defp check_variants(acc, _), do: acc

  defp check_sample_size({issues, recs, score}, size) when size > 0 and size < 300 do
    {
      issues ++ ["sample size may be too small"],
      recs ++ ["increase sample size or extend test duration"],
      score - 1.3
    }
  end
  defp check_sample_size(acc, _), do: acc

  defp check_guardrail({issues, recs, score}, false) do
    {
      issues ++ ["missing guardrail metric"],
      recs ++ ["add bounce-rate, error-rate, or complaint-rate guardrail"],
      score - 1.2
    }
  end
  defp check_guardrail(acc, _), do: acc
end
