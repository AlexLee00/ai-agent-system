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
      primary_metric: Zoi.default(Zoi.string(), ""),
      baseline_defined: Zoi.default(Zoi.boolean(), false),
      baseline: Zoi.default(Zoi.any(), nil),
      variant_count: Zoi.default(Zoi.integer(), 0),
      variants: Zoi.default(Zoi.any(), nil),
      sample_size: Zoi.default(Zoi.integer(), 0),
      has_guardrail_metric: Zoi.default(Zoi.boolean(), false),
      guardrails: Zoi.default(Zoi.any(), nil),
      min_detectable_effect: Zoi.default(Zoi.any(), nil)
    })

  @impl Jido.Action
  def run(params, _ctx) do
    hypothesis = String.trim(Map.get(params, :hypothesis, "") || "")
    # Accept either :metric or :primary_metric
    metric = String.trim((Map.get(params, :metric) || Map.get(params, :primary_metric, "")) || "")
    # Accept either :baseline_defined (bool) or :baseline (value present)
    baseline_defined =
      Map.get(params, :baseline_defined, false) ||
        not is_nil(Map.get(params, :baseline))
    # Accept either :variant_count or :variants (list)
    variants = Map.get(params, :variants)
    variant_count =
      Map.get(params, :variant_count) ||
        (if is_list(variants), do: length(variants), else: 0)
    sample_size = Map.get(params, :sample_size, 0) || 0
    # Accept either :has_guardrail_metric or :guardrails (non-empty list)
    guardrails = Map.get(params, :guardrails)
    has_guardrail_metric =
      Map.get(params, :has_guardrail_metric, false) ||
        (is_list(guardrails) && length(guardrails) > 0)

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
